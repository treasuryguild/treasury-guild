-- Run with psql -f against an EMPTY disposable PostgreSQL database.
-- Everything, including the schema and roles, is rolled back.
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
\ir ../migrations/0019_budget_setup_history.sql
\ir ../migrations/0020_workgroup_lifecycle.sql
\ir ../migrations/0021_task_lifecycle.sql
\ir ../migrations/0022_budget_reset.sql
\ir ../migrations/0023_task_numbers_budget_month.sql

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

-- Data written under the single-assignee schema, before 0024 runs.
insert into contributors(wallet_address, github_username) values
  ('admin', null), ('alice', 'alice'), ('bob', null), ('member', null), ('outsider', null);
insert into communities(id, slug, name, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'test-guild', 'Test guild', 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000','admin','admin'),
  ('10000000-0000-0000-0000-000000000000','member','member');
insert into workgroups(id,community_id,name) values
  ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000','Board');
insert into tasks(id,workgroup_id,title,source,gh_assignee_login,assignee_wallet) values
  ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Linked issue','github','Alice','alice'),
  ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','Unlinked issue','github','carol',null),
  ('30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','Native task','native',null,'admin'),
  ('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000001','Unassigned task','native',null,null);

\ir ../migrations/0024_task_assignees.sql

-- Backfill: login -> github row (with its wallet), wallet-only -> manual row, nothing -> no row.
do $$ begin
  if (select count(*) from task_assignees) <> 3 then raise exception 'Wrong backfill count'; end if;
  if not exists (select 1 from task_assignees where task_id='30000000-0000-0000-0000-000000000001'
    and source='github' and gh_login='Alice' and wallet_address='alice') then
    raise exception 'Linked github assignee not backfilled'; end if;
  if not exists (select 1 from task_assignees where task_id='30000000-0000-0000-0000-000000000002'
    and source='github' and gh_login='carol' and wallet_address is null) then
    raise exception 'Unlinked github assignee not backfilled'; end if;
  if not exists (select 1 from task_assignees where task_id='30000000-0000-0000-0000-000000000003'
    and source='manual' and gh_login is null and wallet_address='admin') then
    raise exception 'Manual assignee not backfilled'; end if;
  if exists (select 1 from task_assignees where task_id='30000000-0000-0000-0000-000000000004') then
    raise exception 'Unassigned task gained an assignee'; end if;
  if exists (select 1 from information_schema.columns where table_name='tasks'
    and column_name in ('assignee_wallet','gh_assignee_login')) then
    raise exception 'Old assignee columns survived'; end if;
end $$;

-- Shape constraints: a wallet or a login appears once per task; source and login agree.
do $$
declare t1 uuid := '30000000-0000-0000-0000-000000000001';
begin
  perform pg_temp.reject(format('insert into task_assignees(task_id,source,wallet_address) values(%L,''manual'',''alice'')',t1),'23505');
  perform pg_temp.reject(format('insert into task_assignees(task_id,source,gh_login) values(%L,''github'',''ALICE'')',t1),'23505');
  perform pg_temp.reject(format('insert into task_assignees(task_id,source,gh_login,wallet_address) values(%L,''manual'',''bob'',''bob'')',t1),'23514');
  perform pg_temp.reject(format('insert into task_assignees(task_id,source) values(%L,''github'')',t1),'23514');
  -- A second assignee with a different wallet is the whole point.
  insert into task_assignees(task_id,source,wallet_address,position) values (t1,'manual','bob',1);
  if (select count(*) from task_assignees where task_id=t1) <> 2 then raise exception 'Second assignee missing'; end if;
end $$;

-- Members read assignees of their community's tasks; outsiders see none; nobody writes via RLS.
set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claims','{"wallet":"member"}',true);
  if (select count(*) from task_assignees) <> 4 then raise exception 'Member cannot read assignees'; end if;
  perform pg_temp.reject('insert into task_assignees(task_id,source,wallet_address) values(''30000000-0000-0000-0000-000000000004'',''manual'',''member'')','42501');
  perform pg_temp.reject('update task_assignees set wallet_address=''member''','42501');
  perform pg_temp.reject('delete from task_assignees','42501');
  perform set_config('request.jwt.claims','{"wallet":"outsider"}',true);
  if (select count(*) from task_assignees) <> 0 then raise exception 'Outsider can read assignees'; end if;
end $$;
reset role;

-- Archived tasks and workgroups refuse assignee edits; deleting a task cascades.
do $$
declare t4 uuid := '30000000-0000-0000-0000-000000000004';
begin
  insert into task_assignees(task_id,source,wallet_address) values (t4,'manual','member');
  update tasks set archived_at=now() where id=t4;
  perform pg_temp.reject(format('insert into task_assignees(task_id,source,wallet_address) values(%L,''manual'',''bob'')',t4),'23514');
  perform pg_temp.reject(format('update task_assignees set wallet_address=''bob'' where task_id=%L',t4),'23514');
  delete from tasks where id=t4;
  if exists (select 1 from task_assignees where task_id=t4) then raise exception 'Cascade delete failed'; end if;
  perform pg_temp.reject('insert into task_assignees(task_id,source,wallet_address) values(''30000000-0000-0000-0000-000000000009'',''manual'',''bob'')','23503');
end $$;
select change_workgroup_lifecycle('20000000-0000-0000-0000-000000000001','archive','admin');
select pg_temp.reject('insert into task_assignees(task_id,source,wallet_address) values(''30000000-0000-0000-0000-000000000003'',''manual'',''bob'')','23514');
select change_workgroup_lifecycle('20000000-0000-0000-0000-000000000001','restore','admin');

-- payouts: the same task may pay several wallets in one transaction, each once per unit.
insert into treasuries(id,community_id,name,network,required,address,script_cbor) values
  ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000','Wallet',0,1,'address','00');
insert into transactions(id,treasury_id,tx_cbor,created_by) values
  ('50000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','00','admin');
do $$
declare tx uuid := '50000000-0000-0000-0000-000000000001'; t1 uuid := '30000000-0000-0000-0000-000000000001';
begin
  insert into payouts(transaction_id,task_id,contributor_wallet,unit,amount) values
    (tx,t1,'alice','lovelace',100), (tx,t1,'bob','lovelace',100), (tx,t1,'bob','token',5);
  perform pg_temp.reject(format('insert into payouts(transaction_id,task_id,contributor_wallet,unit,amount) values(%L,%L,''bob'',''lovelace'',100)',tx,t1),'23505');
end $$;

rollback;
\echo Task assignee tests passed.
