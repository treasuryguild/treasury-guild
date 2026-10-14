-- A setup is effective until the next setup starts. Unique start dates make
-- overlapping active setups impossible; amounts are complete project snapshots.
create table public.budget_setup_states (
  workgroup_id uuid primary key references public.workgroups(id) on delete cascade,
  revision integer not null default 0,
  legacy_conflict boolean not null default false
);
create table public.budget_setups (
  id uuid primary key default gen_random_uuid(),
  workgroup_id uuid not null references public.workgroups(id) on delete cascade,
  starts_on date not null check (extract(day from starts_on) = 1),
  mode text not null check (mode in ('recurring', 'monthly', 'quarterly')),
  cadence text not null check (cadence in ('monthly', 'quarterly')),
  amounts jsonb not null default '[]',
  check (mode = 'recurring' or mode = cadence),
  check (cadence <> 'quarterly' or extract(month from starts_on) in (1,4,7,10)),
  unique(workgroup_id, starts_on)
);
create table public.budget_plans (
  setup_id uuid not null references public.budget_setups(id) on delete cascade,
  starts_on date not null,
  amounts jsonb not null,
  primary key(setup_id, starts_on)
);
create table public.budget_changes (
  id uuid primary key default gen_random_uuid(),
  workgroup_id uuid not null references public.workgroups(id) on delete cascade,
  changed_at timestamptz not null default now(),
  changed_by text not null,
  effective_on date not null,
  reason text,
  before_value jsonb not null,
  after_value jsonb not null
);
create index budget_changes_history_idx on public.budget_changes(workgroup_id, changed_at desc);
grant select, insert, update, delete on public.budget_setup_states, public.budget_setups,
  public.budget_plans, public.budget_changes to service_role;

alter table public.budget_setup_states enable row level security;
alter table public.budget_setups enable row level security;
alter table public.budget_plans enable row level security;
alter table public.budget_changes enable row level security;
create policy budget_setup_states_read on public.budget_setup_states for select
  using (public.is_member(public.workgroup_community(workgroup_id)));
create policy budget_setups_read on public.budget_setups for select
  using (public.is_member(public.workgroup_community(workgroup_id)));
create policy budget_plans_read on public.budget_plans for select using (exists (
  select 1 from public.budget_setups s where s.id = setup_id
    and public.is_member(public.workgroup_community(s.workgroup_id))));
create policy budget_changes_read on public.budget_changes for select
  using (public.is_member(public.workgroup_community(workgroup_id)));

-- Preserve every legacy row. Only unambiguous projects are imported automatically.
-- Existing recurring defaults have no recoverable earlier versions.
insert into public.budget_setup_states(workgroup_id, legacy_conflict)
select workgroup_id, count(distinct (case when budget_month is null then 'recurring' else cadence end, cadence)) > 1
from public.workgroup_budgets group by workgroup_id;
insert into public.budget_setups(workgroup_id, starts_on, mode, cadence, amounts)
select b.workgroup_id, coalesce(min(b.budget_month), date '1000-01-01'),
  case when min(b.budget_month) is null then 'recurring' else min(b.cadence) end,
  min(b.cadence), case when min(b.budget_month) is null then
    jsonb_agg(jsonb_build_object('unit', b.unit, 'amount', b.amount::text,
      'asset_label', b.asset_label, 'decimals', b.decimals) order by b.unit) else '[]'::jsonb end
from public.workgroup_budgets b join public.budget_setup_states s using(workgroup_id)
where not s.legacy_conflict group by b.workgroup_id;
insert into public.budget_plans(setup_id, starts_on, amounts)
select s.id, b.budget_month, jsonb_agg(jsonb_build_object('unit', b.unit,
  'amount', b.amount::text, 'asset_label', b.asset_label, 'decimals', b.decimals) order by b.unit)
from public.workgroup_budgets b join public.budget_setups s using(workgroup_id)
where b.budget_month is not null group by s.id, b.budget_month;

-- Old clients must not bypass the new timeline or mutate the preserved archive.
create function public.freeze_legacy_budgets() returns trigger language plpgsql as $$
begin
  raise exception 'Reload the budgets page to use dated budget setups' using errcode = '23514';
end;
$$;
create trigger freeze_legacy_budgets before insert or update on public.workgroup_budgets
for each statement execute function public.freeze_legacy_budgets();
create or replace function public.replace_workgroup_dated_budgets(
  p_workgroup_id uuid, p_budgets jsonb, p_created_by text, p_budget_month date, p_budget_cadence text
) returns void language plpgsql as $$ begin
  raise exception 'Reload the budgets page to use dated budget setups' using errcode = '23514';
end; $$;

create function public.save_budget_setup(
  p_workgroup_id uuid, p_expected_revision integer, p_mode text, p_cadence text,
  p_starts_on date, p_amounts jsonb, p_actor text, p_confirm boolean default false,
  p_reason text default null
) returns integer language plpgsql security invoker set search_path = public as $$
declare
  v_state public.budget_setup_states;
  v_old public.budget_setups;
  v_id uuid;
  v_switch boolean;
  v_before jsonb;
  v_current_month date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  perform id from public.workgroups where id = p_workgroup_id for update;
  if not found then raise exception 'Workgroup not found' using errcode = '23514'; end if;
  insert into public.budget_setup_states(workgroup_id) values(p_workgroup_id) on conflict do nothing;
  select * into v_state from public.budget_setup_states where workgroup_id = p_workgroup_id;
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
  select * into v_old from public.budget_setups where workgroup_id = p_workgroup_id
    and starts_on <= p_starts_on order by starts_on desc limit 1;
  v_switch := v_old.id is null or v_old.mode <> p_mode or v_old.cadence <> p_cadence;
  if v_switch and (v_old.id is not null or v_state.legacy_conflict) then
    if p_confirm is not true then raise exception 'Review and confirm the budget setup change' using errcode = '23514'; end if;
    if p_starts_on < v_current_month then
      raise exception 'Setup changes cannot rewrite past periods. Choose the current or a future period.' using errcode = '23514';
    end if;
    if (v_old.cadence = 'quarterly' or v_old.id is null and v_state.legacy_conflict and exists (
      select 1 from public.workgroup_budgets where workgroup_id = p_workgroup_id and cadence = 'quarterly'))
      and extract(month from p_starts_on) not in (1,4,7,10) then
      raise exception 'Switch quarterly budgets at a quarter boundary: January, April, July or October' using errcode = '23514';
    end if;
  end if;
  if p_starts_on < v_current_month and nullif(trim(p_reason),'') is null then
    raise exception 'Provide a reason to correct a past budget' using errcode = '23514';
  end if;
  if (v_switch or p_mode = 'recurring' and p_starts_on >= v_current_month) and exists (
    select 1 from public.budget_setups where workgroup_id = p_workgroup_id and starts_on > p_starts_on
  ) then
    raise exception 'A later setup is already scheduled. Edit that setup or choose a date after it.' using errcode = '23514';
  end if;
  v_before := jsonb_build_object('setup', case when v_old.id is null then null else to_jsonb(v_old) end, 'plans', coalesce((
    select jsonb_agg(to_jsonb(b)) from public.budget_plans b where b.setup_id = v_old.id
  ), '[]'::jsonb));
  -- A historical correction changes one period, then restores the old recurring
  -- amount unless another version already starts there.
  if not v_switch and p_mode = 'recurring' and p_starts_on < v_current_month then
    insert into public.budget_setups(workgroup_id, starts_on, mode, cadence, amounts)
      values(p_workgroup_id, (p_starts_on + case when p_cadence = 'quarterly' then interval '3 months' else interval '1 month' end)::date,
        v_old.mode, v_old.cadence, v_old.amounts)
      on conflict(workgroup_id, starts_on) do nothing;
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
      insert into public.budget_setups(workgroup_id, starts_on, mode, cadence, amounts)
        values(p_workgroup_id, p_starts_on, p_mode, p_cadence,
          case when p_mode = 'recurring' then p_amounts else '[]'::jsonb end) returning id into v_id;
    end if;
  else v_id := v_old.id;
  end if;
  if p_mode <> 'recurring' then
    insert into public.budget_plans(setup_id, starts_on, amounts) values(v_id, p_starts_on, p_amounts)
      on conflict(setup_id, starts_on) do update set amounts = excluded.amounts;
  end if;
  insert into public.budget_changes(workgroup_id, changed_by, effective_on, reason, before_value, after_value)
    values(p_workgroup_id, p_actor, p_starts_on, nullif(trim(p_reason),''), v_before,
      jsonb_build_object('mode',p_mode,'cadence',p_cadence,'amounts',p_amounts));
  update public.budget_setup_states set revision = revision + 1 where workgroup_id = p_workgroup_id
    returning revision into p_expected_revision;
  return p_expected_revision;
end;
$$;
revoke all on function public.save_budget_setup(uuid,integer,text,text,date,jsonb,text,boolean,text) from public;
grant execute on function public.save_budget_setup(uuid,integer,text,text,date,jsonb,text,boolean,text) to service_role;

-- One database snapshot supplies both amounts and concurrency revisions.
create function public.budget_setup_workspace(p_community_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'workgroupId', w.id, 'workgroupName', w.name, 'workgroupKind', w.kind,
    'revision', coalesce(st.revision,0), 'legacyConflict', coalesce(st.legacy_conflict,false),
    'timeline', coalesce((select jsonb_agg(to_jsonb(s) order by s.starts_on)
      from public.budget_setups s where s.workgroup_id = w.id), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(to_jsonb(p) order by p.starts_on)
      from public.budget_plans p join public.budget_setups s on s.id = p.setup_id
      where s.workgroup_id = w.id), '[]'::jsonb),
    'legacy', case when st.legacy_conflict then coalesce((select jsonb_agg(
      jsonb_build_object('unit',b.unit,'amount',b.amount::text,'asset_label',b.asset_label,
        'decimals',b.decimals,'cadence',b.cadence,'budget_month',b.budget_month))
      from public.workgroup_budgets b where b.workgroup_id = w.id), '[]'::jsonb) else '[]'::jsonb end,
    'history', coalesce((select jsonb_agg(to_jsonb(h)) from (
      select changed_at, changed_by, effective_on, reason, before_value, after_value
      from public.budget_changes where workgroup_id = w.id order by changed_at desc, id desc limit 20
    ) h), '[]'::jsonb)
  ) order by w.name), '[]'::jsonb)
  from public.workgroups w left join public.budget_setup_states st on st.workgroup_id = w.id
  where w.community_id = p_community_id;
$$;
revoke all on function public.budget_setup_workspace(uuid) from public;
grant execute on function public.budget_setup_workspace(uuid) to service_role;
