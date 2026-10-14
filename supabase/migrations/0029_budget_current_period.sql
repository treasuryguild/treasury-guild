-- A budget period is "past" only once it has ended for its cadence: editing
-- the current quarter's plan in its second or third month is not a historical
-- correction and needs no reason. Setup switches still cannot start before the
-- current month. Otherwise identical to 0019.
create or replace function public.save_budget_setup(
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
  v_period_start date;
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
  if p_starts_on < v_period_start and nullif(trim(p_reason),'') is null then
    raise exception 'Provide a reason to correct a past budget' using errcode = '23514';
  end if;
  if (v_switch or p_mode = 'recurring' and p_starts_on >= v_period_start) and exists (
    select 1 from public.budget_setups where workgroup_id = p_workgroup_id and starts_on > p_starts_on
  ) then
    raise exception 'A later setup is already scheduled. Edit that setup or choose a date after it.' using errcode = '23514';
  end if;
  v_before := jsonb_build_object('setup', case when v_old.id is null then null else to_jsonb(v_old) end, 'plans', coalesce((
    select jsonb_agg(to_jsonb(b)) from public.budget_plans b where b.setup_id = v_old.id
  ), '[]'::jsonb));
  -- A historical correction changes one period, then restores the old recurring
  -- amount unless another version already starts there.
  if not v_switch and p_mode = 'recurring' and p_starts_on < v_period_start then
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
