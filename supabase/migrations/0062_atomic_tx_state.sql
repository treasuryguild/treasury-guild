-- Transaction state changes that also move tasks, as one database transaction
-- each. Before this the poller confirmed in four writes and the reject and
-- delete routes released queued tasks in a second write, so a failure in
-- between left a confirmed payout with unpaid tasks, or tasks queued forever
-- (the browser may only move pay_state between none and payable, 0046).
--
--   1. pay_tasks_for_tx: the one statement that marks tasks paid, shared by
--      confirm_transaction and import_chain_tx.
--   2. confirm_transaction: submitted -> confirmed with its payouts and tasks.
--   3. reject_transaction / delete_pending_transaction: the guarded rejection
--      and delete, releasing the payout's queued tasks in the same step.
--   4. release_orphaned_queued_tasks: the sweep's repair for rows orphaned
--      before this migration.
--   5. cosigner_decisions.error: a signing failure after a passed check.

-- 1. Paying tasks -----------------------------------------------------------------

-- Paid, with the confirming hash, and a native task parked in its board's Paid
-- column when it has one (0033). GitHub tasks keep their column: it lives on
-- GitHub and the write-back moves it there.
create function public.pay_tasks_for_tx(p_tx_hash text, p_task_ids uuid[]) returns void
language sql security invoker set search_path = public as $$
  update tasks t set pay_state = 'paid', paid_tx_hash = p_tx_hash,
      column_id = case when t.source = 'native' then coalesce(
          (select c.id from board_columns c where c.workgroup_id = t.workgroup_id and c.marks_paid limit 1),
          t.column_id)
        else t.column_id end
    where t.id = any(p_task_ids);
$$;
revoke all on function public.pay_tasks_for_tx(text, uuid[]) from public, anon, authenticated;
grant execute on function public.pay_tasks_for_tx(text, uuid[]) to service_role;

-- import_chain_tx (0045), unchanged except that a settled task is claimed by
-- the guarded update and then paid by pay_tasks_for_tx.
create or replace function public.import_chain_tx(p_tx_hash text, p_plan jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  e public.external_txs;
  v_treasury uuid := (p_plan->>'treasuryId')::uuid;
  v_kind text := p_plan->>'kind';
  v_time timestamptz := (p_plan->>'blockTime')::timestamptz;
  v_community uuid;
  v_tx uuid;
  v_task uuid;
  v_number integer;
  v_column uuid;
  v_ids jsonb := '{}';
  v_numbers jsonb := '{}';
  t jsonb;
begin
  select * into e from external_txs where tx_hash = p_tx_hash for update;
  if not found then return jsonb_build_object('status', 'gone'); end if;
  if e.treasury_id <> v_treasury then
    raise exception 'Transaction belongs to another treasury' using errcode = '23514';
  end if;
  if v_kind not in ('payout', 'payment') then
    raise exception 'Unknown import kind' using errcode = '23514';
  end if;
  select community_id into v_community from treasuries where id = v_treasury;

  if exists (select 1 from transactions where treasury_id = v_treasury and tx_hash = p_tx_hash) then
    delete from external_txs where tx_hash = p_tx_hash;
    return jsonb_build_object('status', 'already');
  end if;

  insert into contributors (wallet_address)
    select jsonb_array_elements_text(coalesce(p_plan->'contributors', '[]'))
    on conflict do nothing;

  for t in select * from jsonb_array_elements(coalesce(p_plan->'tasks', '[]')) loop
    if not exists (select 1 from workgroups
        where id = (t->>'workgroupId')::uuid and community_id = v_community) then
      raise exception 'Workgroup not found' using errcode = '23503';
    end if;

    if t->>'mode' = 'settle' then
      -- The claim: still the unpaid task the plan saw.
      update tasks set budget_month = coalesce(budget_month, (t->>'budgetMonth')::date)
        where id = (t->>'taskId')::uuid and community_id = v_community
          and workgroup_id = (t->>'workgroupId')::uuid
          and number = (t->>'chainNumber')::integer
          and pay_state = 'payable' and archived_at is null
        returning id, number into v_task, v_number;
      if not found then
        raise exception 'number_conflict' using errcode = 'P0001';
      end if;
      perform pay_tasks_for_tx(p_tx_hash, array[v_task]);
    else
      -- The board's Paid column, where a paid native task sits.
      select id into v_column from board_columns
        where workgroup_id = (t->>'workgroupId')::uuid and marks_paid limit 1;
      insert into tasks (workgroup_id, source, title, body, amounts, bounty_lovelace,
          pay_state, audited, column_id, budget_month, paid_tx_hash, number, chain_number,
          created_at, updated_at)
        values ((t->>'workgroupId')::uuid, 'native', t->>'title',
          'Imported from the on-chain payout record. The title and description are not stored on-chain.',
          t->'amounts', (t->>'bountyLovelace')::bigint, 'paid', true, v_column,
          (t->>'budgetMonth')::date, p_tx_hash,
          case when t->>'mode' = 'keep' then (t->>'chainNumber')::integer end,
          (t->>'chainNumber')::integer, v_time, v_time)
        returning id, number into v_task, v_number;
      insert into task_assignees (task_id, source, wallet_address, position)
        select v_task, 'manual', x.wallet, (x.ord - 1)::int
        from jsonb_array_elements_text(t->'wallets') with ordinality x(wallet, ord);
    end if;
    v_ids := v_ids || jsonb_build_object(t->>'chainNumber', v_task);
    v_numbers := v_numbers || jsonb_build_object(t->>'chainNumber', v_number);
  end loop;

  -- History: every timestamp is the block time, and discord_notified_at is set
  -- so the sweep never announces it.
  insert into transactions (treasury_id, kind, tx_cbor, tx_hash, description,
      signed_addresses, state, created_by, created_at, submitted_at, discord_notified_at)
    values (v_treasury, v_kind, p_plan->>'txCbor', p_tx_hash, p_plan->>'description',
      array(select jsonb_array_elements_text(coalesce(p_plan->'signedAddresses', '[]'))),
      2, p_plan->>'createdBy', v_time, v_time, v_time)
    returning id into v_tx;

  if v_kind = 'payout' then
    insert into payouts (transaction_id, task_id, contributor_wallet, unit, amount, status, created_at)
      select v_tx, (v_ids->>(p->>'chainNumber'))::uuid, p->>'wallet', p->>'unit',
        (p->>'amount')::bigint, 'confirmed', v_time
      from jsonb_array_elements(coalesce(p_plan->'payouts', '[]')) p;
    insert into community_assets (community_id, field_name, unit, decimals)
      select v_community, a->>'fieldName', a->>'unit', (a->>'decimals')::int
      from jsonb_array_elements(coalesce(p_plan->'assets', '[]')) a
      on conflict (community_id, field_name) do nothing;
  else
    insert into payments (transaction_id, community_id, treasury_id, recipient_wallet,
        recipient_treasury_id, label, unit, amount, budget_month, created_at)
      select v_tx, v_community, v_treasury, p->>'recipientWallet',
        (p->>'recipientTreasuryId')::uuid, p->>'label', p->>'unit',
        (p->>'amount')::numeric, (p->>'budgetMonth')::date, v_time
      from jsonb_array_elements(coalesce(p_plan->'payments', '[]')) p;
  end if;

  delete from external_txs where tx_hash = p_tx_hash;
  return jsonb_build_object('status', 'imported', 'transactionId', v_tx,
    'taskIds', v_ids, 'numbers', v_numbers);
end $$;

-- 2. Confirmation ---------------------------------------------------------------------

-- The poller found a submitted transaction on-chain. The row lock and the
-- state check are the idempotency guard: a second call (a concurrent poll, a
-- retry) finds state 2 and answers false, having changed nothing.
create function public.confirm_transaction(p_transaction_id uuid, p_block_time timestamptz)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  x public.transactions;
begin
  select * into x from transactions where id = p_transaction_id for update;
  if not found or x.state <> 1 then return false; end if;
  update transactions set state = 2, block_time = p_block_time where id = x.id;
  update payouts set status = 'confirmed' where transaction_id = x.id and status = 'submitted';
  -- One payouts row per (task, wallet, unit): each task once.
  perform pay_tasks_for_tx(x.tx_hash,
    array(select distinct task_id from payouts where transaction_id = x.id));
  return true;
end $$;
revoke all on function public.confirm_transaction(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.confirm_transaction(uuid, timestamptz) to service_role;

-- 3. Rejection and deletion -------------------------------------------------------------

-- Record a rejection on a pending transaction whose lists are still the ones
-- the route read (false otherwise: a concurrent submit, signature or
-- rejection). Whether the rule is still reachable is decided by the caller
-- (thresholdStillReachable); a dead transaction is rejected and its queued
-- tasks go back to payable here, in the same step.
create function public.reject_transaction(
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
    update tasks set pay_state = 'payable'
      where pay_state = 'queued'
        and id in (select task_id from payouts where transaction_id = x.id);
  end if;
  return true;
end $$;
revoke all on function public.reject_transaction(uuid, text[], text[], text[], boolean) from public, anon, authenticated;
grant execute on function public.reject_transaction(uuid, text[], text[], text[], boolean) to service_role;

-- Delete a transaction only while it is pending (false when a submit got
-- there first), releasing its queued tasks before the payouts rows that name
-- them cascade away.
create function public.delete_pending_transaction(p_transaction_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  x public.transactions;
begin
  select * into x from transactions where id = p_transaction_id for update;
  if not found or x.state <> 0 then return false; end if;
  update tasks set pay_state = 'payable'
    where pay_state = 'queued'
      and id in (select task_id from payouts where transaction_id = x.id);
  delete from transactions where id = x.id;
  return true;
end $$;
revoke all on function public.delete_pending_transaction(uuid) from public, anon, authenticated;
grant execute on function public.delete_pending_transaction(uuid) to service_role;

-- 4. Repair -------------------------------------------------------------------------------

-- A queued task belongs to a pending or submitted payout. One with no payouts
-- row in a live transaction was left behind by a failed release (before this
-- migration): back to payable. build-payout inserts the payouts rows before
-- it queues the tasks, so a build in flight is never touched.
create function public.release_orphaned_queued_tasks() returns integer
language sql security definer set search_path = public as $$
  with released as (
    update tasks t set pay_state = 'payable'
    where t.pay_state = 'queued'
      and not exists (
        select 1 from payouts p join transactions x on x.id = p.transaction_id
        where p.task_id = t.id and x.state in (0, 1, 2)
      )
    returning 1
  )
  select count(*)::integer from released;
$$;
revoke all on function public.release_orphaned_queued_tasks() from public, anon, authenticated;
grant execute on function public.release_orphaned_queued_tasks() to service_role;

-- 5. Co-signer signing failures -----------------------------------------------------------

-- The check passed but the witness could not be added (the key could not be
-- decrypted, the witness did not verify): the reason, so the transaction page
-- can show why a treasury waits. `problems` stays the check's own findings.
alter table public.cosigner_decisions
  add column error text,
  add constraint cosigner_decisions_error_check check (error is null or (passed and not signed));
