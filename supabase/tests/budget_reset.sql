-- Run with psql -f against an EMPTY disposable PostgreSQL database.
-- Schema, fixtures, and roles are rolled back.
\set ON_ERROR_STOP on
begin;
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
\ir ../migrations/0001_core.sql
\ir ../migrations/0002_treasury.sql
\ir ../migrations/0003_boards.sql
\ir ../migrations/0004_github.sql
\ir ../migrations/0005_payouts.sql
\ir ../migrations/0006_reconciliation.sql
\ir ../migrations/0007_rls.sql
\ir ../migrations/0008_github_fields.sql
\ir ../migrations/0009_multi_asset.sql
\ir ../migrations/0010_workgroup_wallets.sql
\ir ../migrations/0011_roles_github.sql
\ir ../migrations/0012_visibility_membership.sql
\ir ../migrations/0013_minting.sql
\ir ../migrations/0014_budgets_incoming_details.sql
\ir ../migrations/0015_budget_asset_metadata.sql
\ir ../migrations/0016_replace_workgroup_budgets.sql
\ir ../migrations/0017_dated_budgets.sql
\ir ../migrations/0018_quarterly_budget_plans.sql

insert into contributors(wallet_address) values ('admin'), ('lead'), ('member');
insert into communities(id, slug, name, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'reset-test', 'Reset test', 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000','admin','admin'),
  ('10000000-0000-0000-0000-000000000000','lead','member'),
  ('10000000-0000-0000-0000-000000000000','member','member');
insert into workgroups(id, community_id, name)
  select ('20000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
    '10000000-0000-0000-0000-000000000000', 'Group ' || n from generate_series(1,6) n;
insert into workgroup_leads(workgroup_id,wallet_address)
  values('20000000-0000-0000-0000-000000000001','lead');
-- Import real legacy data, including a mixed configuration.
insert into workgroup_budgets(workgroup_id,cadence,unit,amount,created_by,budget_month) values
  ('20000000-0000-0000-0000-000000000001','monthly','lovelace',100,'admin',null),
  ('20000000-0000-0000-0000-000000000002','monthly','lovelace',100,'admin',null),
  ('20000000-0000-0000-0000-000000000002','monthly','lovelace',200,'admin','2030-01-01');
\ir ../migrations/0019_budget_setup_history.sql
\ir ../migrations/0020_workgroup_lifecycle.sql
\ir ../migrations/0021_task_lifecycle.sql
\ir ../migrations/0022_budget_reset.sql

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

set local role service_role;
do $$
declare wid uuid := '20000000-0000-0000-0000-000000000001'; snap jsonb; revision integer;
begin
  revision := save_budget_setup(wid,0,'monthly','monthly','2030-01-01',
    '[{"unit":"lovelace","amount":"300","decimals":6}]','admin',true);
  snap := workgroup_budget_snapshot(wid);
  if jsonb_array_length(snap->'legacy') <> 1 or jsonb_array_length(snap->'plans') <> 1 then
    raise exception 'Invalid snapshot fixture'; end if;
  perform pg_temp.reject(format('select reset_workgroup_budgets(%L,1,''lead'',''Group 1'',''Mistake'')',wid),'42501');
  perform pg_temp.reject(format('select reset_workgroup_budgets(%L,1,''admin'',''Wrong'',''Mistake'')',wid),'23514');
  perform pg_temp.reject(format('select reset_workgroup_budgets(%L,1,''admin'',''Group 1'','' '')',wid),'23514');
  perform pg_temp.reject(format('select reset_workgroup_budgets(%L,0,''admin'',''Group 1'',''Mistake'')',wid),'40001');
  if workgroup_budget_snapshot(wid) <> snap or exists(select 1 from workgroup_events where action='budget_reset') then
    raise exception 'Rejected reset changed data'; end if;
  revision := reset_workgroup_budgets(wid,1,'admin','Group 1','Wrong dates');
  if revision <> 2 or (budget_reset_status(wid)->>'hasBudgets')::boolean or
    exists(select 1 from budget_plans) or exists(select 1 from budget_changes where workgroup_id=wid) then
    raise exception 'Reset did not clear all budgets'; end if;
  if not exists(select 1 from workgroup_events where workgroup_id=wid and action='budget_reset'
    and actor='admin' and reason='Wrong dates' and budget_snapshot=snap) then
    raise exception 'Complete reset audit missing'; end if;
  perform pg_temp.reject(format('select save_budget_setup(%L,1,''monthly'',''monthly'',''2030-01-01'',''[]'',''admin'')',wid),'40001');
  perform pg_temp.reject(format('select reset_workgroup_budgets(%L,1,''admin'',''Group 1'',''Retry'')',wid),'40001');
  revision := save_budget_setup(wid,2,'quarterly','quarterly','2030-04-01',
    '[{"unit":"lovelace","amount":"500","decimals":6}]','admin');
  if revision <> 3 then raise exception 'Cannot configure budgets after reset'; end if;
  -- Deletion automatically clears configuration without requiring another reset.
  snap := workgroup_budget_snapshot(wid);
  perform change_workgroup_lifecycle(wid,'delete','admin','Group 1');
  if exists(select 1 from workgroups where id=wid) or
    not exists(select 1 from workgroup_events where workgroup_id=wid and action='delete' and budget_snapshot=snap) or
    not exists(select 1 from workgroup_events where workgroup_id=wid and action='budget_reset') then
    raise exception 'Deletion lost the budget audit'; end if;

  -- Mixed legacy configurations reset cleanly, including the conflict marker.
  wid := '20000000-0000-0000-0000-000000000002';
  if not (select legacy_conflict from budget_setup_states where workgroup_id=wid) then raise exception 'Missing conflict fixture'; end if;
  revision := reset_workgroup_budgets(wid,0,'admin','Group 2','Mixed defaults');
  if (select legacy_conflict from budget_setup_states where workgroup_id=wid) or
    exists(select 1 from workgroup_budgets where workgroup_id=wid) then raise exception 'Legacy reset incomplete'; end if;
  perform save_budget_setup(wid,revision,'monthly','monthly','2030-01-01','[]','admin');
  perform change_workgroup_lifecycle(wid,'archive','admin');
  perform pg_temp.reject(format('select reset_workgroup_budgets(%L,2,''admin'',''Group 2'',''Mistake'')',wid),'23514');
  -- Cascades must also work for archived budget-only groups.
  perform change_workgroup_lifecycle(wid,'delete','admin','Group 2');
end $$;

insert into tasks(id,workgroup_id,title) values
  ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','Unpaid task'),
  ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004','Payment task');
insert into treasuries(id,community_id,name,network,required,address,script_cbor) values
  ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000','Wallet',0,1,'address','00');
insert into transactions(id,treasury_id,tx_cbor,created_by) values
  ('50000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','00','admin');
do $$
declare wid uuid := '20000000-0000-0000-0000-000000000003'; state text; snapshot jsonb;
begin
  perform save_budget_setup(wid,0,'recurring','monthly','2030-01-01','[]','admin');
  -- Even a non-payable task must be handled through its own deletion rules.
  if (workgroup_lifecycle_status(wid)->>'canDelete')::boolean then raise exception 'Task group deletable'; end if;
  perform pg_temp.reject(format('delete from workgroups where id=%L',wid),'23514');
  foreach state in array array['payable','queued','paid','reconciled'] loop
    update tasks set pay_state=state::task_pay_state where workgroup_id=wid;
    perform pg_temp.reject(format('select reset_workgroup_budgets(%L,1,''admin'',''Group 3'',''Mistake'')',wid),'23514');
  end loop;
  update tasks set pay_state='payable', archived_at=now() where workgroup_id=wid;
  perform pg_temp.reject(format('select reset_workgroup_budgets(%L,1,''admin'',''Group 3'',''Mistake'')',wid),'23514');
  update tasks set archived_at=null where workgroup_id=wid;
  update tasks set pay_state='none' where workgroup_id=wid;
  perform reset_workgroup_budgets(wid,1,'admin','Group 3','Uncommitted setup');
  if not exists(select 1 from tasks where workgroup_id=wid) then raise exception 'Reset deleted tasks'; end if;

  wid := '20000000-0000-0000-0000-000000000004';
  perform save_budget_setup(wid,0,'monthly','monthly','2030-01-01','[]','admin');
  snapshot := workgroup_budget_snapshot(wid);
  insert into payouts(transaction_id,task_id,contributor_wallet,unit,amount)
    values('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','admin','lovelace',100);
  foreach state in array array['pending','submitted','confirmed','written_back','adjusted'] loop
    update payouts set status=state;
    perform pg_temp.reject(format('select reset_workgroup_budgets(%L,1,''admin'',''Group 4'',''Mistake'')',wid),'23514');
  end loop;
  update transactions set state=3;
  perform pg_temp.reject(format('select reset_workgroup_budgets(%L,1,''admin'',''Group 4'',''Mistake'')',wid),'23514');
  perform pg_temp.reject(format('select change_workgroup_lifecycle(%L,''delete'',''admin'',''Group 4'')',wid),'23514');
  if workgroup_budget_snapshot(wid) <> snapshot or not exists(select 1 from payouts) then
    raise exception 'Blocked cleanup changed payment or budget history'; end if;
end $$;
reset role;

-- Explicitly deleting an eligible task lets the empty group be removed too.
select set_config('request.jwt.claims','{"wallet":"admin"}',true);
set local role authenticated;
select change_task_lifecycle('30000000-0000-0000-0000-000000000001','archive');
select change_task_lifecycle('30000000-0000-0000-0000-000000000001','delete','Unpaid task');
do $$ begin
  perform pg_temp.reject('select reset_workgroup_budgets(''20000000-0000-0000-0000-000000000003'',2,''admin'',''Group 3'',''Mistake'')','42501');
  perform pg_temp.reject('delete from workgroup_events','42501');
end $$;
reset role;
set local role service_role;
select change_workgroup_lifecycle('20000000-0000-0000-0000-000000000003','delete','admin','Group 3');
do $$ begin
  if not exists(select 1 from task_events where task_id='30000000-0000-0000-0000-000000000001' and action='delete') then
    raise exception 'Task deletion audit lost'; end if;
  perform pg_temp.reject('update workgroup_events set reason=''changed''','42501');
  perform pg_temp.reject('delete from workgroup_events','42501');
end $$;
reset role;
rollback;
\echo Budget reset tests passed.
