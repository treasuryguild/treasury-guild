-- Canceled transactions (F1 redesign) + cosigner signing intent:
--   * state = 4 (Canceled) frees the one-pending slot while keeping
--     payout/payment/task reservations until TTL expiry or on-chain confirm.
--   * valid_to_slot is the denormalized spend TTL (~36h at build); null means
--     no automatic release (pre-TTL rows / operator hold).
--   * reject-dead of a signed pending tx cancels (retain) instead of releasing.
--   * cosign_claimed_at serializes app co-sign with cancel under the tx row lock.

-- 1. Schema -------------------------------------------------------------------------------

alter table public.transactions drop constraint if exists transactions_state_check;
alter table public.transactions
  add constraint transactions_state_check check (state in (0, 1, 2, 3, 4));

alter table public.transactions
  add column if not exists valid_to_slot bigint,
  add column if not exists cosign_claimed_at timestamptz;

comment on column public.transactions.valid_to_slot is
  'Spend TTL slot (invalidHereafter) stamped at build; null = no automatic cancel release.';
comment on column public.transactions.cosign_claimed_at is
  'App co-signer claim; cancel refuses while this is within the intent window.';

-- 2. cancel_pending_transaction -----------------------------------------------------------

create or replace function public.cancel_pending_transaction(p_transaction_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  x public.transactions;
begin
  select * into x from transactions where id = p_transaction_id for update;
  if not found or x.state <> 0 then return false; end if;
  if coalesce(cardinality(x.signed_addresses), 0) = 0 then return false; end if;
  -- An in-flight app co-sign holds the row for a few minutes.
  if x.cosign_claimed_at is not null
      and x.cosign_claimed_at > now() - interval '5 minutes' then
    raise exception 'Co-signer is signing this transaction; try again shortly'
      using errcode = '40001';
  end if;
  update transactions
    set state = 4, cosign_claimed_at = null
  where id = x.id;
  return true;
end $$;
revoke all on function public.cancel_pending_transaction(uuid) from public, anon, authenticated;
grant execute on function public.cancel_pending_transaction(uuid) to service_role;

-- 3. reject_transaction — signed dead → cancel-retain ------------------------------------

create or replace function public.reject_transaction(
  p_transaction_id uuid, p_expected_signed text[], p_expected_rejected text[],
  p_rejected text[], p_dead boolean
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  x public.transactions;
  signed boolean;
begin
  select * into x from transactions where id = p_transaction_id for update;
  if not found or x.state <> 0
      or x.signed_addresses is distinct from p_expected_signed
      or x.rejected_addresses is distinct from p_expected_rejected then
    return false;
  end if;
  signed := coalesce(cardinality(x.signed_addresses), 0) > 0;
  if p_dead and signed then
    if x.cosign_claimed_at is not null
        and x.cosign_claimed_at > now() - interval '5 minutes' then
      raise exception 'Co-signer is signing this transaction; try again shortly'
        using errcode = '40001';
    end if;
    update transactions set rejected_addresses = p_rejected, state = 4, cosign_claimed_at = null
      where id = x.id;
    return true;
  end if;
  update transactions set rejected_addresses = p_rejected,
      state = case when p_dead then 3 else state end
    where id = x.id;
  if p_dead then
    update tasks set pay_state = 'payable', live_payout_tx_id = null
      where pay_state = 'queued'
        and id in (select task_id from payouts where transaction_id = x.id);
  end if;
  return true;
end $$;

-- 4. confirm_transaction — accept canceled ------------------------------------------------

create or replace function public.confirm_transaction(p_transaction_id uuid, p_block_time timestamptz)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  x public.transactions;
begin
  select * into x from transactions where id = p_transaction_id for update;
  -- Pending (0), submitted (1), or canceled (4): a canceled row whose hash
  -- is on-chain was broadcast after cancel and must settle once.
  if not found or x.state not in (0, 1, 4) then return false; end if;
  update transactions set
      state = 2,
      block_time = p_block_time,
      submitted_at = coalesce(submitted_at, p_block_time),
      cosign_claimed_at = null
    where id = x.id;
  update payouts set status = 'confirmed'
    where transaction_id = x.id and status in ('pending', 'submitted');
  perform pay_tasks_for_tx(x.tx_hash,
    array(select distinct task_id from payouts where transaction_id = x.id));
  return true;
end $$;

-- 5. Cosign intent ------------------------------------------------------------------------

create or replace function public.claim_cosign_intent(p_transaction_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  x public.transactions;
begin
  select * into x from transactions where id = p_transaction_id for update;
  if not found or x.state <> 0 then return false; end if;
  if x.cosign_claimed_at is not null
      and x.cosign_claimed_at > now() - interval '5 minutes' then
    return false;
  end if;
  update transactions set cosign_claimed_at = now() where id = x.id;
  return true;
end $$;
revoke all on function public.claim_cosign_intent(uuid) from public, anon, authenticated;
grant execute on function public.claim_cosign_intent(uuid) to service_role;

create or replace function public.clear_cosign_intent(p_transaction_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update transactions set cosign_claimed_at = null where id = p_transaction_id;
end $$;
revoke all on function public.clear_cosign_intent(uuid) from public, anon, authenticated;
grant execute on function public.clear_cosign_intent(uuid) to service_role;

-- 6. release_expired_canceled_transactions ------------------------------------------------

-- Slot timelines differ by network: the sweep passes each network's current
-- slot. Rows with null valid_to_slot are never auto-released.
create or replace function public.release_expired_canceled_transactions(
  p_network integer, p_now_slot bigint, p_lag_slots bigint
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  r record;
begin
  for r in
    select x.id from transactions x
    join treasuries t on t.id = x.treasury_id
    where x.state = 4
      and t.network = p_network
      and x.valid_to_slot is not null
      and x.valid_to_slot < p_now_slot - p_lag_slots
    order by x.id
    for update of x skip locked
  loop
    update tasks set pay_state = 'payable', live_payout_tx_id = null
      where pay_state = 'queued'
        and id in (select task_id from payouts where transaction_id = r.id);
    update transactions set state = 3, cosign_claimed_at = null where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.release_expired_canceled_transactions(integer, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.release_expired_canceled_transactions(integer, bigint, bigint)
  to service_role;

-- 7. Live task claim — canceled (4) counts as live ---------------------------------------

create or replace function public.claim_tasks_for_payout(p_transaction_id uuid, p_task_ids uuid[])
returns void
language plpgsql security definer set search_path = public as $$
declare
  x public.transactions;
  n integer;
  claimed integer;
begin
  if p_task_ids is null or cardinality(p_task_ids) = 0 then
    raise exception 'No tasks to claim' using errcode = '23514';
  end if;

  select * into x from transactions where id = p_transaction_id for update;
  if not found or x.state <> 0 then
    raise exception 'Transaction is no longer pending' using errcode = 'P0002';
  end if;

  perform 1 from tasks where id = any(p_task_ids) order by id for update;

  select count(*) into n from tasks where id = any(p_task_ids);
  if n <> cardinality(p_task_ids) then
    raise exception 'Task not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from tasks t
    where t.id = any(p_task_ids)
      and (t.pay_state <> 'payable' or t.live_payout_tx_id is not null or t.archived_at is not null)
  ) then
    raise exception 'One or more tasks are already in a payout transaction'
      using errcode = '23505';
  end if;

  if exists (
    select 1 from payouts p
    join transactions tx on tx.id = p.transaction_id
    where p.task_id = any(p_task_ids)
      and tx.state in (0, 1, 2, 4)
      and tx.id <> p_transaction_id
  ) then
    raise exception 'One or more tasks are already in a payout transaction'
      using errcode = '23505';
  end if;

  update tasks
    set live_payout_tx_id = p_transaction_id, pay_state = 'queued'
  where id = any(p_task_ids)
    and pay_state = 'payable'
    and live_payout_tx_id is null
    and archived_at is null;
  get diagnostics claimed = row_count;
  if claimed <> cardinality(p_task_ids) then
    raise exception 'One or more tasks are already in a payout transaction'
      using errcode = '23505';
  end if;
end $$;

create or replace function public.release_orphaned_queued_tasks() returns integer
language sql security definer set search_path = public as $$
  with released as (
    update tasks t set pay_state = 'payable', live_payout_tx_id = null
    where t.pay_state = 'queued'
      and not exists (
        select 1 from payouts p join transactions x on x.id = p.transaction_id
        where p.task_id = t.id and x.state in (0, 1, 2, 4)
      )
    returning 1
  )
  select count(*)::integer from released;
$$;
