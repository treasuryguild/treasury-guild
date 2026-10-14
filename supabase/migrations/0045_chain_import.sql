-- Chain import: rebuild payouts and manual payments that another Treasury Guild
-- database built (the local stack against the same treasury, a lost record)
-- from the transaction itself. pollTreasury already records such a tx in
-- external_txs with its label-190001 record; the import (src/lib/chainImport)
-- plans the rows in TypeScript and import_chain_tx writes them in one
-- database transaction, then drops the external row. What cannot be resolved
-- stays in external_txs as 'blocked' with the reasons, for an admin.

-- 1. Import state on external rows ---------------------------------------------

-- import_status NULL = not evaluated yet (or a transient failure to retry);
-- 'blocked' = needs an admin, reasons in import_issues; 'ignored' = an admin
-- dismissed it; 'skipped' = the label-190001 record is not a Treasury Guild one.
alter table external_txs
  add column import_status text check (import_status in ('blocked', 'ignored', 'skipped')),
  add column import_issues jsonb not null default '[]',
  add column import_checked_at timestamptz;
create index external_txs_import_pending_idx on external_txs(treasury_id, block_time)
  where payout_meta is not null and import_status is null;

-- 2. Chain numbers ---------------------------------------------------------------

-- The task number the payout metadata names. Set on every task the import
-- creates: equal to `number` when that number was free here, different when an
-- admin imported the task under a new number. NULL on every other task.
alter table public.tasks add column chain_number integer check (chain_number > 0);

-- Numbers stay database-issued with one exception: an imported task keeps the
-- number the chain already records for it, which is `number = chain_number` on
-- insert. The advisory lock is still taken and tasks_community_number_uq still
-- rejects a number that is in use. tasks_insert forbids chain_number from the
-- browser, so only the service role can take this path.
create or replace function public.assign_task_number() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select community_id into new.community_id from workgroups where id = new.workgroup_id;
  if new.community_id is null then
    raise exception 'Workgroup not found' using errcode = '23503';
  end if;
  perform pg_advisory_xact_lock(hashtext('task_number:' || new.community_id::text));
  if new.chain_number is not null and new.number = new.chain_number then
    return new;
  end if;
  select coalesce(max(number), 0) + 1 into new.number
    from tasks where community_id = new.community_id;
  return new;
end $$;

create or replace function public.guard_task_identity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.number <> old.number or new.community_id <> old.community_id
    or new.chain_number is distinct from old.chain_number then
    raise exception 'Task numbers are permanent' using errcode = '23514';
  end if;
  return new;
end $$;

drop policy tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert
  with check (source = 'native' and archived_at is null and chain_number is null
    and public.can_manage_workgroup(workgroup_id));

-- 3. Workgroup names an admin resolved -----------------------------------------

-- The metadata names a workgroup by (truncated) name. When no active workgroup
-- carries that name an admin creates one or points the name at an existing
-- workgroup; the choice is kept so later transactions import on their own.
create table public.workgroup_import_aliases (
  community_id uuid not null references public.communities(id) on delete cascade,
  name text not null check (octet_length(name) between 1 and 64),
  workgroup_id uuid not null references public.workgroups(id) on delete cascade,
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (community_id, name)
);
alter table public.workgroup_import_aliases enable row level security;
create policy workgroup_import_aliases_read on public.workgroup_import_aliases for select
  using (public.is_member(community_id));
revoke all on public.workgroup_import_aliases from anon, authenticated, service_role;
grant select on public.workgroup_import_aliases to authenticated;
grant select, insert, update, delete on public.workgroup_import_aliases to service_role;

-- 4. The import ------------------------------------------------------------------

-- p_plan (built by src/lib/chainImport/plan.ts):
--   { kind: 'payout' | 'payment', treasuryId, txCbor, description,
--     signedAddresses: [wallet], createdBy, blockTime,
--     contributors: [wallet],
--     assets:   [{ fieldName, unit, decimals }],
--     tasks:    [{ chainNumber, mode: 'keep' | 'new' | 'settle', taskId,
--                  workgroupId, title, amounts, bountyLovelace, budgetMonth,
--                  wallets: [wallet] }],
--     payouts:  [{ chainNumber, wallet, unit, amount }],
--     payments: [{ recipientWallet, recipientTreasuryId, label, unit, amount,
--                  budgetMonth }] }
-- The lock on the external row is the idempotency guard: the sweep and the
-- on-visit sync serialize on it, and the loser finds the row gone. Any raise
-- rolls the whole transaction back, so a tx is imported completely or not at
-- all.
create function public.import_chain_tx(p_tx_hash text, p_plan jsonb) returns jsonb
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
    -- The board's Paid column, as markTasksPaid does for native tasks.
    select id into v_column from board_columns
      where workgroup_id = (t->>'workgroupId')::uuid and marks_paid limit 1;

    if t->>'mode' = 'settle' then
      update tasks set pay_state = 'paid', paid_tx_hash = p_tx_hash,
          budget_month = coalesce(budget_month, (t->>'budgetMonth')::date),
          column_id = case when source = 'native' and v_column is not null then v_column else column_id end
        where id = (t->>'taskId')::uuid and community_id = v_community
          and workgroup_id = (t->>'workgroupId')::uuid
          and number = (t->>'chainNumber')::integer
          and pay_state = 'payable' and archived_at is null
        returning id, number into v_task, v_number;
      if not found then
        raise exception 'number_conflict' using errcode = 'P0001';
      end if;
    else
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

revoke all on function public.import_chain_tx(text, jsonb) from public, authenticated, anon;
grant execute on function public.import_chain_tx(text, jsonb) to service_role;
