-- Run with psql -f against an EMPTY disposable PostgreSQL database.
-- The minimal prerequisites and all test records are rolled back.
\set ON_ERROR_STOP on
begin;
create role service_role;
create table public.workgroups (id uuid primary key);
create table public.incoming_txs (id uuid primary key);
create function public.is_member(uuid) returns boolean language sql as 'select true';
create function public.workgroup_community(uuid) returns uuid language sql as 'select $1';
\ir ../migrations/0014_budgets_incoming_details.sql
\ir ../migrations/0015_budget_asset_metadata.sql
\ir ../migrations/0016_replace_workgroup_budgets.sql

insert into public.workgroups values ('00000000-0000-0000-0000-000000000001');
select public.replace_workgroup_budgets(
  '00000000-0000-0000-0000-000000000001',
  '[{"unit":"lovelace","cadence":"monthly","amount":"100","asset_label":"ADA","decimals":6}]',
  'test-wallet'
);
\ir ../migrations/0017_dated_budgets.sql
\ir ../migrations/0018_quarterly_budget_plans.sql

do $$
declare
  wg uuid := '00000000-0000-0000-0000-000000000001';
  saved_id uuid;
begin
  if (select amount from public.workgroup_budgets where budget_month is null) <> 100 then
    raise exception 'Migration changed the existing default';
  end if;
  perform public.replace_workgroup_period_budgets(wg,
    '[{"unit":"lovelace","cadence":"monthly","amount":"200","asset_label":"ADA","decimals":6}]',
    'test-wallet', '2026-09-01');
  perform public.replace_workgroup_period_budgets(wg,
    '[{"unit":"lovelace","cadence":"monthly","amount":"300","asset_label":"ADA","decimals":6}]',
    'test-wallet', '2026-10-01');
  select id into saved_id from public.workgroup_budgets where budget_month = '2026-09-01';
  perform public.replace_workgroup_period_budgets(wg,
    '[{"unit":"lovelace","cadence":"monthly","amount":"250","asset_label":"ADA","decimals":6}]',
    'test-wallet', '2026-09-01');
  if (select count(*) from public.workgroup_budgets) <> 3
    or (select amount from public.workgroup_budgets where id = saved_id) <> 250
    or (select amount from public.workgroup_budgets where budget_month = '2026-10-01') <> 300 then
    raise exception 'Editing September did not preserve October and stable record identity';
  end if;

  -- Failed replacements must roll back deletions as well as inserts.
  begin
    perform public.replace_workgroup_period_budgets(wg,
      '[{"unit":"other","cadence":"quarterly","amount":"1","asset_label":"BAD","decimals":0}]',
      'test-wallet', '2026-09-01');
    raise exception 'Accepted a quarterly allocation assigned to one month';
  exception when check_violation then null;
  end;
  if not exists (select 1 from public.workgroup_budgets where id = saved_id and amount = 250) then
    raise exception 'Invalid save deleted the previous allocation';
  end if;

  perform public.replace_workgroup_period_budgets(wg, '[]', 'test-wallet', '2026-09-01');
  if (select count(*) from public.workgroup_budgets) <> 2
    or exists (select 1 from public.workgroup_budgets where budget_month = '2026-09-01') then
    raise exception 'Removing September changed other periods';
  end if;

  -- The legacy entry point must only replace recurring defaults.
  perform public.replace_workgroup_budgets(wg, '[]', 'test-wallet');
  if (select count(*) from public.workgroup_budgets) <> 1
    or (select amount from public.workgroup_budgets where budget_month = '2026-10-01') <> 300 then
    raise exception 'Legacy replacement deleted dated allocations';
  end if;

  if has_function_privilege('public', 'public.replace_workgroup_period_budgets(uuid,jsonb,text,date)', 'execute') then
    raise exception 'Period replacement is executable by public';
  end if;
end;
$$;
do $$
declare
  wg uuid := '00000000-0000-0000-0000-000000000001';
begin
  perform public.replace_workgroup_dated_budgets(wg,
    '[{"unit":"lovelace","cadence":"quarterly","amount":"900","asset_label":"ADA","decimals":6}]',
    'test-wallet', '2026-10-01', 'quarterly');
  perform public.replace_workgroup_dated_budgets(wg,
    '[{"unit":"lovelace","cadence":"quarterly","amount":"1000","asset_label":"ADA","decimals":6}]',
    'test-wallet', '2027-01-01', 'quarterly');
  perform public.replace_workgroup_dated_budgets(wg,
    '[{"unit":"lovelace","cadence":"quarterly","amount":"1200","asset_label":"ADA","decimals":6}]',
    'test-wallet', '2026-10-01', 'quarterly');
  if (select count(*) from public.workgroup_budgets) <> 3
    or (select amount from public.workgroup_budgets where cadence = 'monthly' and budget_month = '2026-10-01') <> 300
    or (select amount from public.workgroup_budgets where cadence = 'quarterly' and budget_month = '2026-10-01') <> 1200
    or (select amount from public.workgroup_budgets where budget_month = '2027-01-01') <> 1000 then
    raise exception 'Quarter editing changed another quarter or its overlapping monthly allocation';
  end if;
  begin
    perform public.replace_workgroup_dated_budgets(wg, '[]', 'test-wallet', '2026-11-01', 'quarterly');
    raise exception 'Accepted a non-quarter start date';
  exception when check_violation then null;
  end;
  -- Older monthly callers cannot remove the quarter sharing October's start.
  perform public.replace_workgroup_period_budgets(wg, '[]', 'test-wallet', '2026-10-01');
  if (select count(*) from public.workgroup_budgets) <> 2 then
    raise exception 'Monthly delete removed quarterly allocations';
  end if;
  perform public.replace_workgroup_dated_budgets(wg, '[]', 'test-wallet', '2026-10-01', 'quarterly');
  if (select count(*) from public.workgroup_budgets) <> 1
    or (select amount from public.workgroup_budgets where budget_month = '2027-01-01') <> 1000 then
    raise exception 'Quarter deletion changed another quarter';
  end if;
  if has_function_privilege('public', 'public.replace_workgroup_dated_budgets(uuid,jsonb,text,date,text)', 'execute') then
    raise exception 'Dated replacement is executable by public';
  end if;
end;
$$;
rollback;
\echo Dated budget migration checks passed.
