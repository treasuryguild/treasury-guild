-- Payday allocation rules: per paying treasury, optional N% of a payout's
-- paid tokens sent on top of full bounties to an outside wallet (treasury
-- budget spend) or a sibling treasury (transfer). Multiple enabled rules
-- may apply on one Payday build.

create table public.payday_allocation_rules (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  treasury_id uuid not null references public.treasuries(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  -- 1 = 0.01%, 100 = 1%, 10000 = 100%.
  basis_points integer not null check (basis_points between 1 and 10000),
  enabled boolean not null default true,
  unit_scope text not null check (unit_scope in ('all', 'selected')),
  recipient_wallet text,
  recipient_treasury_id uuid references public.treasuries(id) on delete restrict,
  sort_order integer not null default 0,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payday_allocation_rules_destination_xor check (
    num_nonnulls(recipient_wallet, recipient_treasury_id) = 1
  ),
  constraint payday_allocation_rules_not_self check (
    recipient_treasury_id is null or recipient_treasury_id <> treasury_id
  )
);

create index payday_allocation_rules_treasury_idx
  on public.payday_allocation_rules(treasury_id, sort_order, created_at);

comment on table public.payday_allocation_rules is
  'Per paying treasury: N% of Payday paid tokens to an outside wallet or sibling treasury.';

-- Sibling destination must belong to the same community as the paying treasury.
create function public.payday_allocation_rules_guard() returns trigger
language plpgsql as $$
declare
  v_pay_community uuid;
  v_dest_community uuid;
begin
  select community_id into v_pay_community from public.treasuries where id = new.treasury_id;
  if v_pay_community is null then
    raise exception 'Paying treasury not found';
  end if;
  if new.community_id is distinct from v_pay_community then
    raise exception 'Rule community must match the paying treasury';
  end if;
  if new.recipient_treasury_id is not null then
    select community_id into v_dest_community
      from public.treasuries where id = new.recipient_treasury_id;
    if v_dest_community is null or v_dest_community is distinct from v_pay_community then
      raise exception 'Sibling treasury must belong to the same community';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger payday_allocation_rules_guard
  before insert or update on public.payday_allocation_rules
  for each row execute function public.payday_allocation_rules_guard();

alter table public.payday_allocation_rules enable row level security;
create policy payday_allocation_rules_read on public.payday_allocation_rules
  for select using (public.is_member(community_id));
revoke all on public.payday_allocation_rules from anon, authenticated, service_role;
grant select on public.payday_allocation_rules to authenticated;
grant select, insert, update, delete on public.payday_allocation_rules to service_role;

create table public.payday_allocation_rule_units (
  rule_id uuid not null references public.payday_allocation_rules(id) on delete cascade,
  unit text not null check (char_length(unit) between 1 and 120),
  primary key (rule_id, unit)
);

comment on table public.payday_allocation_rule_units is
  'Units a selected-scope Payday allocation rule applies to; empty when unit_scope is all.';

alter table public.payday_allocation_rule_units enable row level security;
create policy payday_allocation_rule_units_read on public.payday_allocation_rule_units
  for select using (exists (
    select 1 from public.payday_allocation_rules r
    where r.id = rule_id and public.is_member(r.community_id)
  ));
revoke all on public.payday_allocation_rule_units from anon, authenticated, service_role;
grant select on public.payday_allocation_rule_units to authenticated;
grant select, insert, update, delete on public.payday_allocation_rule_units to service_role;

-- Payout chain import may also carry allocation payment rows (metadata `a`).
-- Based on migration 0062's import_chain_tx, with payments inserted for payouts too.
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
    insert into payments (transaction_id, community_id, treasury_id, recipient_wallet,
        recipient_treasury_id, label, unit, amount, budget_month, created_at)
      select v_tx, v_community, v_treasury, p->>'recipientWallet',
        (p->>'recipientTreasuryId')::uuid, p->>'label', p->>'unit',
        (p->>'amount')::numeric, (p->>'budgetMonth')::date, v_time
      from jsonb_array_elements(coalesce(p_plan->'payments', '[]')) p;
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
