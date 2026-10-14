-- Replace a workgroup's complete token-budget set in one transaction. The API
-- performs authorization and metadata resolution before calling this service-
-- role-only function.

create function public.replace_workgroup_budgets(
  p_workgroup_id uuid,
  p_budgets jsonb,
  p_created_by text
) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  delete from public.workgroup_budgets
  where workgroup_id = p_workgroup_id
    and unit not in (
      select budget.unit
      from jsonb_to_recordset(p_budgets) as budget(unit text)
    );

  insert into public.workgroup_budgets (
    workgroup_id,
    cadence,
    unit,
    amount,
    asset_label,
    decimals,
    created_by,
    updated_at
  )
  select
    p_workgroup_id,
    budget.cadence,
    budget.unit,
    budget.amount,
    budget.asset_label,
    budget.decimals,
    p_created_by,
    now()
  from jsonb_to_recordset(p_budgets) as budget(
    cadence text,
    unit text,
    amount bigint,
    asset_label text,
    decimals int
  )
  on conflict (workgroup_id, unit) do update set
    cadence = excluded.cadence,
    amount = excluded.amount,
    asset_label = excluded.asset_label,
    decimals = excluded.decimals,
    updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.replace_workgroup_budgets(uuid, jsonb, text)
  from public;
grant execute on function public.replace_workgroup_budgets(uuid, jsonb, text)
  to service_role;
