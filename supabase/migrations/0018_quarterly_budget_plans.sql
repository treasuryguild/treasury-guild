-- Monthly and quarterly plans may share a start date without replacing each other.
alter table public.workgroup_budgets drop constraint workgroup_budgets_month_check;
alter table public.workgroup_budgets add constraint workgroup_budgets_period_check check (
  budget_month is null or (
    extract(day from budget_month) = 1 and
    (cadence = 'monthly' or extract(month from budget_month) in (1, 4, 7, 10))
  )
);

drop index public.workgroup_budgets_period_unit_idx;
create unique index workgroup_budgets_period_unit_idx on public.workgroup_budgets (
  workgroup_id, unit, (coalesce(budget_month, date '0001-01-01')),
  (case when budget_month is null then 'recurring' else cadence end)
);

create function public.replace_workgroup_dated_budgets(
  p_workgroup_id uuid, p_budgets jsonb, p_created_by text,
  p_budget_month date, p_budget_cadence text
) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_budget_cadence is null or p_budget_cadence not in ('monthly', 'quarterly') then
    raise exception 'Invalid budget cadence' using errcode = '23514';
  end if;
  if p_budget_month is not null and (
    extract(day from p_budget_month) <> 1 or
    (p_budget_cadence = 'quarterly' and extract(month from p_budget_month) not in (1, 4, 7, 10)) or
    exists (select 1 from jsonb_to_recordset(p_budgets) as b(cadence text)
      where b.cadence is distinct from p_budget_cadence)
  ) then
    raise exception 'Budget dates and cadence must match the selected period' using errcode = '23514';
  end if;

  perform id from public.workgroups where id = p_workgroup_id for update;
  delete from public.workgroup_budgets
  where workgroup_id = p_workgroup_id
    and budget_month is not distinct from p_budget_month
    and (p_budget_month is null or cadence = p_budget_cadence)
    and unit not in (select b.unit from jsonb_to_recordset(p_budgets) as b(unit text));

  insert into public.workgroup_budgets (
    workgroup_id, cadence, unit, amount, asset_label, decimals,
    created_by, updated_at, budget_month
  )
  select p_workgroup_id, b.cadence, b.unit, b.amount, b.asset_label, b.decimals,
    p_created_by, now(), p_budget_month
  from jsonb_to_recordset(p_budgets) as b(
    cadence text, unit text, amount bigint, asset_label text, decimals int
  )
  on conflict (workgroup_id, unit, (coalesce(budget_month, date '0001-01-01')),
    (case when budget_month is null then 'recurring' else cadence end))
  do update set cadence = excluded.cadence, amount = excluded.amount,
    asset_label = excluded.asset_label, decimals = excluded.decimals, updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.replace_workgroup_dated_budgets(uuid, jsonb, text, date, text) from public;
grant execute on function public.replace_workgroup_dated_budgets(uuid, jsonb, text, date, text) to service_role;

-- Keep earlier callers scoped to monthly plans or recurring defaults.
create or replace function public.replace_workgroup_period_budgets(
  p_workgroup_id uuid, p_budgets jsonb, p_created_by text, p_budget_month date
) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform public.replace_workgroup_dated_budgets(
    p_workgroup_id, p_budgets, p_created_by, p_budget_month, 'monthly'
  );
end;
$$;
