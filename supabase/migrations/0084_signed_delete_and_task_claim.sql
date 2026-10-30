-- Security remediation (F1 + F3):
--   * Refuse delete_pending_transaction once any signature is recorded, so
--     budget/task reservations stay while a signed CBOR may still broadcast.
--   * tasks.live_payout_tx_id claims a task for one live payout transaction;
--     claim_tasks_for_payout locks tasks in id order and sets the claim +
--     queued state atomically so two treasuries cannot both reserve a task.

-- 1. Live task claim -----------------------------------------------------------------

alter table public.tasks
  add column live_payout_tx_id uuid references public.transactions(id) on delete set null;

create index tasks_live_payout_tx_idx on public.tasks(live_payout_tx_id)
  where live_payout_tx_id is not null;

-- Existing queued tasks of pending/submitted/confirmed payouts.
update public.tasks t
  set live_payout_tx_id = sub.transaction_id
from (
  select distinct on (p.task_id) p.task_id, p.transaction_id
  from public.payouts p
  join public.transactions x on x.id = p.transaction_id
  where x.state in (0, 1, 2)
  order by p.task_id, p.transaction_id
) sub
where t.id = sub.task_id
  and t.pay_state = 'queued'
  and t.live_payout_tx_id is null;

-- 2. claim_tasks_for_payout ------------------------------------------------------------

create function public.claim_tasks_for_payout(p_transaction_id uuid, p_task_ids uuid[])
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

  -- Stable lock order avoids deadlocks between overlapping batches.
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

  -- Defense in depth for rows that predate the claim column.
  if exists (
    select 1 from payouts p
    join transactions tx on tx.id = p.transaction_id
    where p.task_id = any(p_task_ids)
      and tx.state in (0, 1, 2)
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
revoke all on function public.claim_tasks_for_payout(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.claim_tasks_for_payout(uuid, uuid[]) to service_role;

-- 3. delete_pending_transaction — refuse once signed ----------------------------------

create or replace function public.delete_pending_transaction(p_transaction_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  x public.transactions;
begin
  select * into x from transactions where id = p_transaction_id for update;
  if not found or x.state <> 0 then return false; end if;
  -- A recorded signature means the CBOR may still be broadcast outside the app.
  if coalesce(cardinality(x.signed_addresses), 0) > 0 then return false; end if;
  update tasks set pay_state = 'payable', live_payout_tx_id = null
    where pay_state = 'queued'
      and id in (select task_id from payouts where transaction_id = x.id);
  delete from transactions where id = x.id;
  return true;
end $$;

-- 4. reject_transaction — clear the claim on dead release -----------------------------

create or replace function public.reject_transaction(
  p_transaction_id uuid, p_expected_signed text[], p_expected_rejected text[],
  p_rejected text[], p_dead boolean
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  x public.transactions;
begin
  select * into x from transactions where id = p_transaction_id for update;
  if not found or x.state <> 0
      or x.signed_addresses is distinct from p_expected_signed
      or x.rejected_addresses is distinct from p_expected_rejected then
    return false;
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

-- 5. pay_tasks_for_tx — clear the claim when paid -------------------------------------

create or replace function public.pay_tasks_for_tx(p_tx_hash text, p_task_ids uuid[]) returns void
language sql security invoker set search_path = public as $$
  update tasks t set pay_state = 'paid', paid_tx_hash = p_tx_hash, live_payout_tx_id = null,
      column_id = case when t.source = 'native' then coalesce(
          (select c.id from board_columns c where c.workgroup_id = t.workgroup_id and c.marks_paid limit 1),
          t.column_id)
        else t.column_id end
    where t.id = any(p_task_ids);
$$;

-- 6. release_orphaned_queued_tasks — clear stale claims -------------------------------

create or replace function public.release_orphaned_queued_tasks() returns integer
language sql security definer set search_path = public as $$
  with released as (
    update tasks t set pay_state = 'payable', live_payout_tx_id = null
    where t.pay_state = 'queued'
      and not exists (
        select 1 from payouts p join transactions x on x.id = p.transaction_id
        where p.task_id = t.id and x.state in (0, 1, 2)
      )
    returning 1
  )
  select count(*)::integer from released;
$$;
