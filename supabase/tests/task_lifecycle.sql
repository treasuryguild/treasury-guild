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
\ir ../migrations/0041_github_task_delete.sql

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

insert into contributors(wallet_address) values ('admin'), ('lead'), ('member'), ('outsider');
insert into communities(id, slug, name, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'test-guild', 'Test guild', 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000','admin','admin'),
  ('10000000-0000-0000-0000-000000000000','lead','member'),
  ('10000000-0000-0000-0000-000000000000','member','member');
insert into workgroups(id,community_id,name) values
  ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000','Board'),
  ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000000','Other board');
insert into workgroup_leads(workgroup_id,wallet_address) values ('20000000-0000-0000-0000-000000000001','lead');
insert into board_columns(id,workgroup_id,name,position,marks_payable) values
  ('60000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Audited',0,true);
insert into tasks(id,workgroup_id,title,pay_state,column_id,audited) values
  ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Unwanted task','payable','60000000-0000-0000-0000-000000000001',true);
insert into tasks(id,workgroup_id,title,source) values
  ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','GitHub issue','github'),
  ('30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000002','Other task','native');

-- Ordinary members, outsiders and leads of another board cannot manage tasks.
set local role authenticated;
do $$
declare wallet text;
begin
  foreach wallet in array array['member','outsider'] loop
    perform set_config('request.jwt.claims',jsonb_build_object('wallet',wallet)::text,true);
    perform pg_temp.reject('select task_lifecycle_status(''30000000-0000-0000-0000-000000000001'')','42501');
    perform pg_temp.reject('select change_task_lifecycle(''30000000-0000-0000-0000-000000000001'',''archive'')','42501');
  end loop;
  perform set_config('request.jwt.claims','{"wallet":"lead"}',true);
  perform pg_temp.reject('select change_task_lifecycle(''30000000-0000-0000-0000-000000000003'',''archive'')','42501');
end $$;

do $$
declare tid uuid := '30000000-0000-0000-0000-000000000001';
begin
  perform pg_temp.reject(format('select change_task_lifecycle(%L,''delete'',''Unwanted task'')',tid),'23514');
  perform pg_temp.reject('select change_task_lifecycle(''30000000-0000-0000-0000-000000000002'',''archive'')','23514');
  perform change_task_lifecycle(tid,'archive');
  perform change_task_lifecycle(tid,'archive');
  if (select count(*) from task_events where task_id=tid) <> 1 then raise exception 'Archive not idempotent'; end if;
  if not (task_lifecycle_status(tid)->>'canDelete')::boolean then raise exception 'Unpaid archive cannot be deleted'; end if;
  if not exists(select 1 from tasks where id=tid and archived_at is not null and pay_state='payable' and audited) then
    raise exception 'Archive lost task state';
  end if;
  update tasks set title='Bypass' where id=tid;
  if exists(select 1 from tasks where title='Bypass') then raise exception 'Archived task editable via RLS'; end if;
  perform change_task_lifecycle(tid,'restore');
  if not exists(select 1 from tasks where id=tid and archived_at is null and pay_state='payable'
    and column_id='60000000-0000-0000-0000-000000000001') then raise exception 'Restore lost column/pay state'; end if;
end $$;
reset role;

-- Service writes and stale payout builds must obey the same protections.
insert into treasuries(id,community_id,name,network,required,address,script_cbor) values
  ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000','Wallet',0,1,'address','00');
insert into transactions(id,treasury_id,tx_cbor,created_by) values
  ('50000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','00','admin');
do $$
declare tid uuid := '30000000-0000-0000-0000-000000000001';
begin
  update tasks set pay_state='queued' where id=tid;
  perform pg_temp.reject(format('select change_task_lifecycle(%L,''archive'')',tid),'23514');
  update tasks set pay_state='payable' where id=tid;
  insert into payouts(transaction_id,task_id,contributor_wallet,unit,amount) values
    ('50000000-0000-0000-0000-000000000001',tid,'admin','lovelace',100);
  if (task_lifecycle_status(tid)->>'canArchive')::boolean then raise exception 'Pending payout omitted'; end if;
  perform pg_temp.reject(format('select change_task_lifecycle(%L,''archive'')',tid),'23514');
  update transactions set state=2;
  update payouts set status='confirmed';
  update tasks set pay_state='paid' where id=tid;
  perform change_task_lifecycle(tid,'archive');
  if (task_lifecycle_status(tid)->>'canDelete')::boolean then raise exception 'Paid task deletable'; end if;
  perform pg_temp.reject(format('select change_task_lifecycle(%L,''delete'',''Unwanted task'')',tid),'23514');
  perform pg_temp.reject(format('update tasks set title=''Bypass'' where id=%L',tid),'23514');
  perform pg_temp.reject(format('update tasks set pay_state=''queued'' where id=%L',tid),'23514');
  perform pg_temp.reject(format('insert into payouts(transaction_id,task_id,contributor_wallet,unit,amount) values(''50000000-0000-0000-0000-000000000001'',%L,''admin'',''token'',1)',tid),'23514');
  update tasks set pay_state='reconciled' where id=tid;
  if (select count(*) from payouts where task_id=tid) <> 1 then raise exception 'Payment history lost'; end if;
end $$;

-- Admin deletion checks exact confirmation; event survives the removed task.
select set_config('request.jwt.claims','{"wallet":"admin"}',true);
set local role authenticated;
do $$
declare tid uuid := '30000000-0000-0000-0000-000000000003';
begin
  perform change_task_lifecycle(tid,'archive');
  perform pg_temp.reject(format('select change_task_lifecycle(%L,''delete'',''Wrong title'')',tid),'23514');
  perform change_task_lifecycle(tid,'delete','Other task');
  if exists(select 1 from tasks where id=tid) then raise exception 'Deletion failed'; end if;
  if not exists(select 1 from task_events where task_id=tid and action='delete' and actor='admin') then
    raise exception 'Deletion audit missing';
  end if;
end $$;
reset role;

-- An archived payable task does not block workgroup archival; its restore
-- remains blocked until the workgroup itself is restored.
insert into tasks(id,workgroup_id,title,pay_state) values
  ('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000002','Cancelled payable','payable');
select change_task_lifecycle('30000000-0000-0000-0000-000000000004','archive');
select change_workgroup_lifecycle('20000000-0000-0000-0000-000000000002','archive','admin');
select pg_temp.reject('select change_task_lifecycle(''30000000-0000-0000-0000-000000000004'',''restore'')','42501');
select change_workgroup_lifecycle('20000000-0000-0000-0000-000000000002','restore','admin');
select change_task_lifecycle('30000000-0000-0000-0000-000000000004','restore');

-- The GitHub sync (service role) deletes unpaid GitHub tasks directly; payment
-- history still blocks it, and native tasks stay archive-first.
insert into tasks(id,workgroup_id,title,source,pay_state) values
  ('30000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000001','Paid GitHub issue','github','payable');
insert into payouts(transaction_id,task_id,contributor_wallet,unit,amount) values
  ('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000005','admin','lovelace',100);
select pg_temp.reject('delete from tasks where id=''30000000-0000-0000-0000-000000000005''','23514');
select pg_temp.reject('delete from tasks where id=''30000000-0000-0000-0000-000000000004''','23514');
delete from tasks where id='30000000-0000-0000-0000-000000000002';
do $$ begin
  if exists(select 1 from tasks where id='30000000-0000-0000-0000-000000000002') then
    raise exception 'Unpaid GitHub task not deletable by the sync';
  end if;
end $$;

set local role anon;
select pg_temp.reject('select change_task_lifecycle(''30000000-0000-0000-0000-000000000004'',''archive'')','42501');
reset role;
rollback;
\echo Task lifecycle tests passed.
