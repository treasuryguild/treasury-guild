-- Run against an EMPTY disposable database; everything is rolled back.
\set ON_ERROR_STOP on
begin;
create role service_role;
create table public.workgroups (id uuid primary key, community_id uuid, name text, kind text);
create table public.incoming_txs (id uuid primary key);
create function public.is_member(uuid) returns boolean language sql as 'select true';
create function public.workgroup_community(uuid) returns uuid language sql as 'select $1';
\ir ../migrations/0014_budgets_incoming_details.sql
\ir ../migrations/0015_budget_asset_metadata.sql
\ir ../migrations/0016_replace_workgroup_budgets.sql
\ir ../migrations/0017_dated_budgets.sql
\ir ../migrations/0018_quarterly_budget_plans.sql
insert into public.workgroups select ('00000000-0000-0000-0000-00000000000' || n)::uuid,
  '00000000-0000-0000-0000-000000000009', 'Project ' || n, 'native' from generate_series(1,3) n;
insert into public.workgroup_budgets(workgroup_id, cadence, unit, amount, created_by, budget_month)
values ('00000000-0000-0000-0000-000000000001','monthly','lovelace',100,'original',null),
  ('00000000-0000-0000-0000-000000000002','monthly','lovelace',100,'original',null),
  ('00000000-0000-0000-0000-000000000002','quarterly','lovelace',900,'original','2030-01-01'),
  ('00000000-0000-0000-0000-000000000003','monthly','lovelace',9223372036854775807,'original','2030-01-01');
\ir ../migrations/0019_budget_setup_history.sql
\ir ../migrations/0029_budget_current_period.sql
insert into public.workgroups values ('00000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000007', 'Quarterly project', 'native');
do $$
declare
  wg uuid := '00000000-0000-0000-0000-000000000001';
  conflict_wg uuid := '00000000-0000-0000-0000-000000000002';
  quarter_wg uuid := '00000000-0000-0000-0000-000000000004';
  this_quarter date := date_trunc('quarter', now() at time zone 'UTC')::date;
  a jsonb := '[{"unit":"lovelace","amount":"200","asset_label":"ADA","decimals":6}]';
  r integer;
begin
  if (select count(*) from public.workgroup_budgets) <> 4 or
     (select count(*) from public.budget_setups) <> 2 or
     not (select legacy_conflict from public.budget_setup_states where workgroup_id = conflict_wg) then
    raise exception 'Migration lost records or failed to flag mixed setups';
  end if;
  if (select amounts->0->>'amount' from public.budget_plans) <> '9223372036854775807' then
    raise exception 'Migration lost base-unit precision';
  end if;
  r := public.save_budget_setup(wg,0,'recurring','monthly','2030-01-01',a,'editor');
  if r <> 1 or (select amounts->0->>'amount' from public.budget_setups where workgroup_id=wg and starts_on='1000-01-01') <> '100' then
    raise exception 'Recurring update rewrote history';
  end if;
  begin
    perform public.save_budget_setup(wg,0,'monthly','monthly','2030-02-01',a,'editor',true);
    raise exception 'Stale save accepted';
  exception when serialization_failure then null; end;
  begin
    perform public.save_budget_setup(wg,1,'monthly','monthly','2030-02-01',a,'editor');
    raise exception 'Unconfirmed transition accepted';
  exception when check_violation then null; end;
  r := public.save_budget_setup(wg,1,'monthly','monthly','2030-02-01',a,'editor',true);
  r := public.save_budget_setup(wg,2,'quarterly','quarterly','2030-04-01',a,'editor',true);
  begin
    perform public.save_budget_setup(wg,3,'monthly','monthly','2030-05-01',a,'editor',true);
    raise exception 'Quarter was split by a mode switch';
  exception when check_violation then null; end;
  r := public.save_budget_setup(wg,3,'monthly','monthly','2030-07-01',a,'editor',true);
  r := public.save_budget_setup(wg,4,'monthly','monthly','2030-08-01',a,'editor');
  r := public.save_budget_setup(wg,5,'quarterly','quarterly','2030-07-01',a,'editor',true);
  if not exists (select 1 from public.budget_changes where workgroup_id=wg and
      jsonb_array_length(before_value->'plans') = 2) then
    raise exception 'Superseded allocations missing from audit';
  end if;
  -- Isolated historical correction restores the original amount the next month.
  r := public.save_budget_setup(wg,6,'recurring','monthly','2020-06-01',a,'editor',false,'Correct imported June amount');
  if (select amounts->0->>'amount' from public.budget_setups where workgroup_id=wg and starts_on='2020-07-01') <> '100' then
    raise exception 'Historical correction leaked into later months';
  end if;
  begin
    perform public.save_budget_setup(wg,7,'monthly','monthly','2020-06-01',a,'editor',true,'bad switch');
    raise exception 'Historical setup change accepted';
  exception when check_violation then null; end;
  begin
    perform public.save_budget_setup(wg,7,'recurring','monthly','2020-05-01',a,'editor');
    raise exception 'Historical correction accepted without reason';
  exception when check_violation then null; end;
  begin
    perform public.save_budget_setup(wg,7,'recurring','monthly','2029-01-01',a,'editor');
    raise exception 'Earlier recurring change silently displaced scheduled setup';
  exception when check_violation then null; end;
  -- The current quarter stays editable without a reason until it has ended,
  -- while a month that has ended still needs one.
  r := public.save_budget_setup(quarter_wg,0,'quarterly','quarterly',(this_quarter - interval '6 months')::date,a,'editor',false,'Backfilled plan');
  r := public.save_budget_setup(quarter_wg,1,'quarterly','quarterly',this_quarter,a,'editor');
  if r <> 2 or (select count(*) from public.budget_setups where workgroup_id = quarter_wg) <> 1 or
     (select count(*) from public.budget_plans p join public.budget_setups s on s.id = p.setup_id
      where s.workgroup_id = quarter_wg) <> 2 then
    raise exception 'Current quarter edit was not saved as a plain plan update';
  end if;
  begin
    perform public.save_budget_setup(quarter_wg,2,'quarterly','quarterly',(this_quarter - interval '3 months')::date,a,'editor');
    raise exception 'Previous quarter corrected without reason';
  exception when check_violation then null; end;
  r := public.save_budget_setup(quarter_wg,2,'quarterly','quarterly',(this_quarter - interval '3 months')::date,a,'editor',false,'Late invoice');
  begin
    perform public.save_budget_setup(conflict_wg,0,'monthly','monthly','2030-02-01',a,'editor',true);
    raise exception 'Legacy quarterly budget split';
  exception when check_violation then null; end;
  r := public.save_budget_setup(conflict_wg,0,'monthly','monthly','2030-04-01',a,'editor',true);
  if (select count(*) from public.workgroup_budgets where workgroup_id=conflict_wg) <> 2 then
    raise exception 'Legacy resolution deleted original budgets';
  end if;
  begin
    perform public.replace_workgroup_budgets(wg,a,'old-client');
    raise exception 'Old API bypassed setup rules';
  exception when check_violation then null; end;
  if jsonb_array_length(public.budget_setup_workspace('00000000-0000-0000-0000-000000000009')) <> 3 or
     jsonb_array_length(public.budget_setup_workspace('00000000-0000-0000-0000-000000000008')) <> 0 then
    raise exception 'Workspace read leaked across communities';
  end if;
  if exists (select 1 from pg_proc p, lateral aclexplode(p.proacl) a
    where p.proname in ('save_budget_setup','budget_setup_workspace') and a.grantee=0 and a.privilege_type='EXECUTE') then
    raise exception 'Public callers can use service-only budget functions';
  end if;
end;
$$;
rollback;
\echo 'Budget setup migration, history, concurrency and transition checks passed.'
