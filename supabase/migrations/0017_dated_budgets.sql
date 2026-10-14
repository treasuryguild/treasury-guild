-- NULL keeps existing recurring defaults. Dated budgets are independent monthly
-- allocations; changing one month must never replace another month's budget.
alter table public.workgroup_budgets
  add column budget_month date,
  add constraint workgroup_budgets_month_check check (
    budget_month is null or
    (extract(day from budget_month) = 1 and cadence = 'monthly')
  ),
  drop constraint workgroup_budgets_workgroup_id_unit_key;

create unique index workgroup_budgets_period_unit_idx
  on public.workgroup_budgets (
    workgroup_id, unit, (coalesce(budget_month, date '0001-01-01'))
  );

create function public.replace_workgroup_period_budgets(
  p_workgroup_id uuid,
  p_budgets jsonb,
  p_created_by text,
  p_budget_month date
) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Serialize replacements for this workgroup, including simultaneous inserts.
  perform id from public.workgroups where id = p_workgroup_id for update;

  delete from public.workgroup_budgets
  where workgroup_id = p_workgroup_id
    and budget_month is not distinct from p_budget_month
    and unit not in (
      select budget.unit from jsonb_to_recordset(p_budgets) as budget(unit text)
    );

  insert into public.workgroup_budgets (
    workgroup_id, cadence, unit, amount, asset_label, decimals,
    created_by, updated_at, budget_month
  )
  select p_workgroup_id, budget.cadence, budget.unit, budget.amount,
    budget.asset_label, budget.decimals, p_created_by, now(), p_budget_month
  from jsonb_to_recordset(p_budgets) as budget(
    cadence text, unit text, amount bigint, asset_label text, decimals int
  )
  on conflict (workgroup_id, unit, (coalesce(budget_month, date '0001-01-01')))
  do update set
    cadence = excluded.cadence,
    amount = excluded.amount,
    asset_label = excluded.asset_label,
    decimals = excluded.decimals,
    updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.replace_workgroup_period_budgets(uuid, jsonb, text, date) from public;
grant execute on function public.replace_workgroup_period_budgets(uuid, jsonb, text, date) to service_role;

-- Older callers may still edit defaults, but cannot delete dated allocations.
create or replace function public.replace_workgroup_budgets(
  p_workgroup_id uuid, p_budgets jsonb, p_created_by text
) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform public.replace_workgroup_period_budgets(
    p_workgroup_id, p_budgets, p_created_by, null
  );
end;
$$;
