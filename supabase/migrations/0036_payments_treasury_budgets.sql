-- Manual payments and treasury budgets.
--
-- A fourth transaction kind, 'payment': one multisig tx from a treasury to any
-- mix of outside addresses, community members and the community's other
-- treasuries, built by the build-payment route. Each output is recorded in
-- `payments` (one row per recipient address and unit, like payouts without a
-- task). An output to a sibling treasury is an internal transfer: it carries
-- no budget month and is never spending (the receiver's incoming_txs row,
-- tagged by tag_internal_transfers, stays the one source of the transfer).
-- Every other output is charged to the paying treasury's own budget.
--
-- Budgets therefore get a second owner: a setup belongs to a workgroup OR a
-- treasury. The three budget tables gain a nullable treasury_id beside the now
-- nullable workgroup_id, a stored `owner_key` ('w:<id>' / 't:<id>') that the
-- functions and unique constraints key on, and RLS that reads through either
-- owner. save_budget_setup gains a trailing p_treasury_id (default null) so
-- existing callers keep working; budget_setup_workspace lists both owners.
-- Budget reset stays workgroup-only: treasury budgets have no legacy data.

-- 1. Transaction kind ---------------------------------------------------------

alter table transactions drop constraint transactions_kind_check;
alter table transactions add constraint transactions_kind_check
  check (kind in ('payout', 'generic', 'mint', 'payment'));

-- 2. Payment rows -------------------------------------------------------------

create table payments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  community_id uuid not null references communities(id) on delete cascade,
  -- The paying wallet (the transaction's treasury), denormalised for budgets.
  treasury_id uuid not null references treasuries(id) on delete cascade,
  recipient_wallet text not null,
  -- Set when the recipient is another treasury of the community: a transfer.
  recipient_treasury_id uuid references treasuries(id) on delete set null,
  -- Member handle or treasury name at build time, for display only.
  label text check (label is null or octet_length(label) <= 64),
  unit text not null,
  -- On-chain base units.
  amount numeric not null check (amount > 0),
  -- The budget period the output counts against (day 1, quarter-aligned when
  -- the treasury budgets by quarter). Always stamped for spend, never for a
  -- transfer.
  budget_month date check (budget_month is null or extract(day from budget_month) = 1),
  check ((recipient_treasury_id is null) = (budget_month is not null)),
  created_at timestamptz not null default now(),
  unique (transaction_id, recipient_wallet, unit)
);
create index payments_transaction_idx on payments(transaction_id);
create index payments_budget_idx on payments(treasury_id, budget_month)
  where budget_month is not null;

alter table payments enable row level security;
create policy payments_read on payments for select using (public.is_member(community_id));
revoke all on payments from anon, authenticated, service_role;
grant select on payments to authenticated;
grant select, insert, update, delete on payments to service_role;

-- 3. Budget owners ------------------------------------------------------------

-- Exactly one of the two ids is set (checked on every table below); the key
-- is what functions and unique constraints match on.
create function public.budget_owner_key(p_workgroup_id uuid, p_treasury_id uuid) returns text
language sql immutable as $$
  select case when p_workgroup_id is not null then 'w:' || p_workgroup_id::text
    when p_treasury_id is not null then 't:' || p_treasury_id::text end
$$;

create function public.treasury_community(tid uuid) returns uuid
language sql stable security definer set search_path = public
as $$ select community_id from treasuries where id = tid $$;

alter table budget_setup_states
  drop constraint budget_setup_states_pkey,
  alter column workgroup_id drop not null,
  add column id uuid not null default gen_random_uuid(),
  add column treasury_id uuid references treasuries(id) on delete cascade;
alter table budget_setup_states add primary key (id);
alter table budget_setup_states
  add column owner_key text generated always as (public.budget_owner_key(workgroup_id, treasury_id)) stored,
  add constraint budget_setup_states_owner_check check (num_nonnulls(workgroup_id, treasury_id) = 1),
  add constraint budget_setup_states_owner_key unique (owner_key);

alter table budget_setups
  alter column workgroup_id drop not null,
  add column treasury_id uuid references treasuries(id) on delete cascade,
  add column owner_key text generated always as (public.budget_owner_key(workgroup_id, treasury_id)) stored,
  add constraint budget_setups_owner_check check (num_nonnulls(workgroup_id, treasury_id) = 1),
  drop constraint budget_setups_workgroup_id_starts_on_key,
  add constraint budget_setups_owner_starts_on_key unique (owner_key, starts_on);

alter table budget_changes
  alter column workgroup_id drop not null,
  add column treasury_id uuid references treasuries(id) on delete cascade,
  add column owner_key text generated always as (public.budget_owner_key(workgroup_id, treasury_id)) stored,
  add constraint budget_changes_owner_check check (num_nonnulls(workgroup_id, treasury_id) = 1);
create index budget_changes_owner_idx on budget_changes(owner_key, changed_at desc);

-- Members read a budget through whichever community owns it.
drop policy budget_setup_states_read on budget_setup_states;
drop policy budget_setups_read on budget_setups;
drop policy budget_plans_read on budget_plans;
drop policy budget_changes_read on budget_changes;
create policy budget_setup_states_read on budget_setup_states for select
  using (public.is_member(coalesce(public.workgroup_community(workgroup_id), public.treasury_community(treasury_id))));
create policy budget_setups_read on budget_setups for select
  using (public.is_member(coalesce(public.workgroup_community(workgroup_id), public.treasury_community(treasury_id))));
create policy budget_plans_read on budget_plans for select using (exists (
  select 1 from budget_setups s where s.id = setup_id
    and public.is_member(coalesce(public.workgroup_community(s.workgroup_id), public.treasury_community(s.treasury_id)))));
create policy budget_changes_read on budget_changes for select
  using (public.is_member(coalesce(public.workgroup_community(workgroup_id), public.treasury_community(treasury_id))));

-- 4. save_budget_setup: same rules, keyed by owner ----------------------------

drop function public.save_budget_setup(uuid, integer, text, text, date, jsonb, text, boolean, text);
create function public.save_budget_setup(
  p_workgroup_id uuid, p_expected_revision integer, p_mode text, p_cadence text,
  p_starts_on date, p_amounts jsonb, p_actor text, p_confirm boolean default false,
  p_reason text default null, p_treasury_id uuid default null
) returns integer language plpgsql security invoker set search_path = public as $$
declare
  v_owner text;
  v_state public.budget_setup_states;
  v_old public.budget_setups;
  v_id uuid;
  v_switch boolean;
  v_before jsonb;
  v_current_month date := date_trunc('month', now() at time zone 'UTC')::date;
  v_period_start date;
begin
  if num_nonnulls(p_workgroup_id, p_treasury_id) <> 1 then
    raise exception 'A budget belongs to exactly one workgroup or treasury' using errcode = '23514';
  end if;
  -- Budget saves, task writes, payouts and lifecycle actions share the owner's row lock.
  if p_workgroup_id is not null then
    perform id from public.workgroups where id = p_workgroup_id for update;
    if not found then raise exception 'Workgroup not found' using errcode = '23514'; end if;
  else
    perform id from public.treasuries where id = p_treasury_id for update;
    if not found then raise exception 'Treasury not found' using errcode = '23514'; end if;
  end if;
  v_owner := public.budget_owner_key(p_workgroup_id, p_treasury_id);
  insert into public.budget_setup_states(workgroup_id, treasury_id) values(p_workgroup_id, p_treasury_id)
    on conflict (owner_key) do nothing;
  select * into v_state from public.budget_setup_states where owner_key = v_owner;
  if p_expected_revision is distinct from v_state.revision then
    raise exception 'Budgets changed since you opened this page. Reload and review your edits.' using errcode = '40001';
  end if;
  if p_mode is null or p_mode not in ('recurring','monthly','quarterly') or
    p_cadence is null or p_cadence not in ('monthly','quarterly') or
    (p_mode <> 'recurring' and p_mode <> p_cadence) or p_starts_on is null or
    p_starts_on < date '1000-01-01' or p_starts_on > date '9999-12-01' or
    extract(day from p_starts_on) <> 1 or
    (p_cadence = 'quarterly' and extract(month from p_starts_on) not in (1,4,7,10)) then
    raise exception 'Choose a valid budget setup and period start' using errcode = '23514';
  end if;
  -- The start of the period containing today, for the cadence being saved.
  v_period_start := case when p_cadence = 'quarterly'
    then date_trunc('quarter', now() at time zone 'UTC')::date else v_current_month end;
  if p_amounts is null or jsonb_typeof(p_amounts) <> 'array' then
    raise exception 'Invalid budget amounts' using errcode = '23514';
  end if;
  if jsonb_array_length(p_amounts) > 50 or exists (
    select 1 from jsonb_array_elements(p_amounts) b where
      jsonb_typeof(b) <> 'object' or coalesce(b->>'unit','') = '' or
      coalesce(b->>'amount','') !~ '^[0-9]+$' or
      coalesce(b->>'decimals','') !~ '^([0-9]|1[012])$'
  ) then raise exception 'Invalid budget amounts' using errcode = '23514'; end if;
  if exists (select 1 from jsonb_array_elements(p_amounts) b
    where (b->>'amount')::numeric <= 0 or (b->>'amount')::numeric > 9223372036854775807) or
    (select count(*) <> count(distinct b->>'unit') from jsonb_array_elements(p_amounts) b) then
    raise exception 'Use unique tokens and positive amounts within the supported range' using errcode = '23514';
  end if;
  select * into v_old from public.budget_setups where owner_key = v_owner
    and starts_on <= p_starts_on order by starts_on desc limit 1;
  v_switch := v_old.id is null or v_old.mode <> p_mode or v_old.cadence <> p_cadence;
  if v_switch and (v_old.id is not null or v_state.legacy_conflict) then
    if p_confirm is not true then raise exception 'Review and confirm the budget setup change' using errcode = '23514'; end if;
    if p_starts_on < v_current_month then
      raise exception 'Setup changes cannot rewrite past periods. Choose the current or a future period.' using errcode = '23514';
    end if;
    if (v_old.cadence = 'quarterly' or v_old.id is null and v_state.legacy_conflict and p_workgroup_id is not null and exists (
      select 1 from public.workgroup_budgets where workgroup_id = p_workgroup_id and cadence = 'quarterly'))
      and extract(month from p_starts_on) not in (1,4,7,10) then
      raise exception 'Switch quarterly budgets at a quarter boundary: January, April, July or October' using errcode = '23514';
    end if;
  end if;
  if p_starts_on < v_period_start and nullif(trim(p_reason),'') is null then
    raise exception 'Provide a reason to correct a past budget' using errcode = '23514';
  end if;
  if (v_switch or p_mode = 'recurring' and p_starts_on >= v_period_start) and exists (
    select 1 from public.budget_setups where owner_key = v_owner and starts_on > p_starts_on
  ) then
    raise exception 'A later setup is already scheduled. Edit that setup or choose a date after it.' using errcode = '23514';
  end if;
  v_before := jsonb_build_object('setup', case when v_old.id is null then null else to_jsonb(v_old) end, 'plans', coalesce((
    select jsonb_agg(to_jsonb(b)) from public.budget_plans b where b.setup_id = v_old.id
  ), '[]'::jsonb));
  -- A historical correction changes one period, then restores the old recurring
  -- amount unless another version already starts there.
  if not v_switch and p_mode = 'recurring' and p_starts_on < v_period_start then
    insert into public.budget_setups(workgroup_id, treasury_id, starts_on, mode, cadence, amounts)
      values(p_workgroup_id, p_treasury_id,
        (p_starts_on + case when p_cadence = 'quarterly' then interval '3 months' else interval '1 month' end)::date,
        v_old.mode, v_old.cadence, v_old.amounts)
      on conflict(owner_key, starts_on) do nothing;
  end if;
  if v_switch or p_mode = 'recurring' then
    if v_old.starts_on = p_starts_on then
      -- Keep allocations as archived records when replacing a boundary setup.
      update public.budget_setups set mode = p_mode, cadence = p_cadence,
        amounts = case when p_mode = 'recurring' then p_amounts else '[]'::jsonb end
        where id = v_old.id returning id into v_id;
      -- Same-date mode switches must not resurrect old period plans later.
      if v_switch then delete from public.budget_plans where setup_id = v_id; end if;
    else
      insert into public.budget_setups(workgroup_id, treasury_id, starts_on, mode, cadence, amounts)
        values(p_workgroup_id, p_treasury_id, p_starts_on, p_mode, p_cadence,
          case when p_mode = 'recurring' then p_amounts else '[]'::jsonb end) returning id into v_id;
    end if;
  else v_id := v_old.id;
  end if;
  if p_mode <> 'recurring' then
    insert into public.budget_plans(setup_id, starts_on, amounts) values(v_id, p_starts_on, p_amounts)
      on conflict(setup_id, starts_on) do update set amounts = excluded.amounts;
  end if;
  insert into public.budget_changes(workgroup_id, treasury_id, changed_by, effective_on, reason, before_value, after_value)
    values(p_workgroup_id, p_treasury_id, p_actor, p_starts_on, nullif(trim(p_reason),''), v_before,
      jsonb_build_object('mode',p_mode,'cadence',p_cadence,'amounts',p_amounts));
  update public.budget_setup_states set revision = revision + 1 where owner_key = v_owner
    returning revision into p_expected_revision;
  return p_expected_revision;
end;
$$;
revoke all on function public.save_budget_setup(uuid,integer,text,text,date,jsonb,text,boolean,text,uuid) from public, anon, authenticated;
grant execute on function public.save_budget_setup(uuid,integer,text,text,date,jsonb,text,boolean,text,uuid) to service_role;

-- 5. budget_setup_workspace: workgroups first, then treasuries -----------------

create or replace function public.budget_setup_workspace(p_community_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  with owners as (
    select 'workgroup'::text as owner_type, w.id as owner_id, w.name as owner_name,
      w.id as workgroup_id, null::uuid as treasury_id, w.kind::text as workgroup_kind,
      public.budget_owner_key(w.id, null) as owner_key, 0 as tier
    from public.workgroups w where w.community_id = p_community_id
    union all
    select 'treasury'::text, t.id, t.name, null::uuid, t.id, null::text,
      public.budget_owner_key(null, t.id), 1
    from public.treasuries t where t.community_id = p_community_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'ownerType', o.owner_type, 'ownerId', o.owner_id, 'ownerName', o.owner_name,
    'workgroupId', o.workgroup_id, 'treasuryId', o.treasury_id, 'workgroupKind', o.workgroup_kind,
    'revision', coalesce(st.revision,0), 'legacyConflict', coalesce(st.legacy_conflict,false),
    'timeline', coalesce((select jsonb_agg(to_jsonb(s) order by s.starts_on)
      from public.budget_setups s where s.owner_key = o.owner_key), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(to_jsonb(p) order by p.starts_on)
      from public.budget_plans p join public.budget_setups s on s.id = p.setup_id
      where s.owner_key = o.owner_key), '[]'::jsonb),
    'legacy', case when st.legacy_conflict and o.workgroup_id is not null then coalesce((select jsonb_agg(
      jsonb_build_object('unit',b.unit,'amount',b.amount::text,'asset_label',b.asset_label,
        'decimals',b.decimals,'cadence',b.cadence,'budget_month',b.budget_month))
      from public.workgroup_budgets b where b.workgroup_id = o.workgroup_id), '[]'::jsonb) else '[]'::jsonb end,
    'history', coalesce((select jsonb_agg(to_jsonb(h)) from (
      select changed_at, changed_by, effective_on, reason, before_value, after_value
      from public.budget_changes where owner_key = o.owner_key order by changed_at desc, id desc limit 20
    ) h), '[]'::jsonb)
  ) order by o.tier, o.owner_name), '[]'::jsonb)
  from owners o left join public.budget_setup_states st on st.owner_key = o.owner_key;
$$;

-- 6. reset_workgroup_budgets: only the states upsert target changes ------------

create or replace function public.reset_workgroup_budgets(
  p_workgroup_id uuid, p_expected_revision integer, p_actor text, p_confirmation text, p_reason text
) returns integer language plpgsql security invoker set search_path = public as $$
declare w public.workgroups; s jsonb; next_revision integer;
begin
  -- Budget saves, task writes, payouts, and lifecycle actions share this lock.
  select * into w from workgroups where id = p_workgroup_id for update;
  if not found then raise exception 'Workgroup not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from community_members where community_id = w.community_id
    and wallet_address = p_actor and role in ('owner','admin')) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;
  if p_confirmation is distinct from w.name then
    raise exception 'Type the workgroup name exactly to confirm budget reset' using errcode = '23514';
  end if;
  if nullif(trim(p_reason),'') is null or length(p_reason) > 500 then
    raise exception 'Provide a reason of up to 500 characters' using errcode = '23514';
  end if;
  s := public.budget_reset_status(w.id);
  if p_expected_revision is distinct from (s->>'revision')::integer then
    raise exception 'Budgets changed since you opened this page. Reload and review before resetting.' using errcode = '40001';
  end if;
  if s->>'blockedReason' is not null then
    raise exception '%', s->>'blockedReason' using errcode = '23514';
  end if;
  if not (s->>'hasBudgets')::boolean then
    raise exception 'This workgroup has no budgets to reset' using errcode = '23514';
  end if;
  insert into workgroup_events(community_id, workgroup_id, workgroup_name, action, actor, reason, budget_snapshot)
    values(w.community_id, w.id, w.name, 'budget_reset', p_actor, trim(p_reason), public.workgroup_budget_snapshot(w.id));
  delete from budget_setups where workgroup_id = w.id;
  delete from budget_changes where workgroup_id = w.id;
  delete from workgroup_budgets where workgroup_id = w.id;
  -- Retain a monotonically increasing revision: stale editors must not revive a reset.
  insert into budget_setup_states(workgroup_id, revision, legacy_conflict)
    values(w.id, 1, false)
    on conflict(owner_key) do update set revision = budget_setup_states.revision + 1, legacy_conflict = false
    returning revision into next_revision;
  return next_revision;
end $$;
