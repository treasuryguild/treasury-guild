-- Run with psql -f against an EMPTY disposable PostgreSQL database.
-- Includes all migrations and rolls back roles, schema, and test records.
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
insert into contributors(wallet_address) values ('admin'), ('member'), ('outsider');
insert into communities(id, slug, name, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'test-guild', 'Test guild', 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000','admin','admin'),
  ('10000000-0000-0000-0000-000000000000','member','member');
insert into workgroups(id, community_id, name) select
  ('20000000-0000-0000-0000-00000000000' || n)::uuid,
  '10000000-0000-0000-0000-000000000000', 'Group ' || n from generate_series(1,5) n;
insert into tasks(id, workgroup_id, title, pay_state) values
  ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Existing task','payable');
\ir ../migrations/0020_workgroup_lifecycle.sql

-- Assert errors without swallowing unexpected failures or success.
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
declare
  used uuid := '20000000-0000-0000-0000-000000000001';
  empty_group uuid := '20000000-0000-0000-0000-000000000002';
  budget_group uuid := '20000000-0000-0000-0000-000000000003';
  removed_task_group uuid := '20000000-0000-0000-0000-000000000004';
  task_id uuid := '30000000-0000-0000-0000-000000000001';
  s jsonb;
begin
  if not (select has_activity from workgroups where id = used) then raise exception 'Existing history not backfilled'; end if;
  perform pg_temp.reject(format('select change_workgroup_lifecycle(%L,%L,%L)', used,'archive','member'),'42501');
  perform pg_temp.reject(format('select change_workgroup_lifecycle(%L,%L,%L)', used,'archive','outsider'),'42501');
  perform pg_temp.reject(format('select change_workgroup_lifecycle(%L,%L,%L)', used,'archive','admin'),'23514');
  perform pg_temp.reject(format('delete from workgroups where id=%L',used),'23514');
  perform pg_temp.reject(format('update workgroups set archived_at=now() where id=%L',used),'23514');
  update tasks set pay_state='paid' where id=task_id;
  insert into treasuries(id, community_id,name,network,required,address,script_cbor) values
    ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000000','Wallet',0,1,'address','00');
  insert into transactions(id,treasury_id,tx_cbor,created_by) values
    ('50000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','00','admin');
  insert into payouts(transaction_id,task_id,contributor_wallet,unit,amount) values
    ('50000000-0000-0000-0000-000000000001',task_id,'admin','lovelace',100);
  s := workgroup_lifecycle_status(used);
  if (s->>'pendingPayouts')::int <> 1 then raise exception 'Pending payout not counted'; end if;
  perform pg_temp.reject(format('select change_workgroup_lifecycle(%L,%L,%L)', used,'archive','admin'),'23514');
  update transactions set state=2;
  update payouts set status='confirmed';
  perform change_workgroup_lifecycle(used,'archive','admin');
  perform change_workgroup_lifecycle(used,'archive','admin');
  if (select count(*) from workgroup_events where workgroup_id=used) <> 1 then raise exception 'Archive is not idempotent'; end if;
  perform pg_temp.reject(format('update tasks set title=%L where id=%L','Changed',task_id),'23514');
  perform pg_temp.reject(format('delete from tasks where id=%L',task_id),'23514');
  perform pg_temp.reject(format('insert into tasks(workgroup_id,title) values(%L,%L)',used,'New task'),'23514');
  perform pg_temp.reject(format('insert into board_columns(workgroup_id,name,position) values(%L,%L,0)',used,'New column'),'23514');
  perform pg_temp.reject(format('update workgroups set name=%L where id=%L','Changed',used),'23514');
  perform pg_temp.reject(format('select save_budget_setup(%L,0,%L,%L,%L,%L,%L)',used,'recurring','monthly','2030-01-01','[]','admin'),'23514');
  update tasks set pay_state='reconciled' where id=task_id;
  if (select count(*) from payouts) <> 1 then raise exception 'Payout history lost'; end if;
  perform change_workgroup_lifecycle(used,'restore','admin');
  update tasks set title='Restored task' where id=task_id;
  perform change_workgroup_lifecycle(used,'archive','admin');

  -- Deleting a task later must not turn a used workgroup into an unused one.
  insert into tasks(workgroup_id,title) values(removed_task_group,'Temporary task');
  delete from tasks where workgroup_id=removed_task_group;
  perform pg_temp.reject(format('select change_workgroup_lifecycle(%L,%L,%L,%L)',removed_task_group,'delete','admin','Group 4'),'23514');
  perform save_budget_setup(budget_group,0,'recurring','monthly','2030-01-01','[]','admin');
  perform change_workgroup_lifecycle(budget_group,'archive','admin');
  perform pg_temp.reject(format('select change_workgroup_lifecycle(%L,%L,%L,%L)',budget_group,'delete','admin','Group 3'),'23514');

  -- Empty seeded boards and local GitHub links may be removed, including archived ones.
  insert into board_columns(workgroup_id,name,position) values(empty_group,'Todo',0);
  insert into github_installations(installation_id,community_id,account_login) values(1,'10000000-0000-0000-0000-000000000000','guild');
  insert into github_repos(id,installation_id,full_name,workgroup_id) values(1,1,'guild/repo',empty_group);
  insert into github_project_links(project_node_id,installation_id,workgroup_id) values('project',1,empty_group);
  perform change_workgroup_lifecycle(empty_group,'archive','admin');
  perform pg_temp.reject('update github_repos set sync_cursor=now() where id=1','23514');
  perform pg_temp.reject(format('select change_workgroup_lifecycle(%L,%L,%L,%L)',empty_group,'delete','admin','Wrong name'),'23514');
  perform change_workgroup_lifecycle(empty_group,'delete','admin','Group 2');
  if exists(select 1 from workgroups where id=empty_group) or
    exists(select 1 from board_columns where workgroup_id=empty_group) or
    exists(select 1 from github_project_links where workgroup_id=empty_group) or
    (select workgroup_id from github_repos where id=1) is not null then raise exception 'Empty group cleanup failed'; end if;
  if not exists(select 1 from workgroup_events where workgroup_id=empty_group and action='delete' and actor='admin') then raise exception 'Deletion audit missing'; end if;
  -- Uninstalling GitHub still cleans up inaccessible connections while preserving history.
  insert into github_installations(installation_id,community_id,account_login) values(2,'10000000-0000-0000-0000-000000000000','guild');
  insert into github_repos(id,installation_id,full_name,workgroup_id) values(2,2,'guild/other','20000000-0000-0000-0000-000000000005');
  insert into github_project_links(project_node_id,installation_id,workgroup_id) values('other-project',2,'20000000-0000-0000-0000-000000000005');
  insert into tasks(workgroup_id,title) values('20000000-0000-0000-0000-000000000005','Retained on uninstall');
  perform change_workgroup_lifecycle('20000000-0000-0000-0000-000000000005','archive','admin');
  delete from github_installations where installation_id=2;
  if exists(select 1 from github_repos where id=2) or
    not exists(select 1 from tasks where title='Retained on uninstall') then raise exception 'Uninstall did not preserve archive'; end if;
  perform change_workgroup_lifecycle('20000000-0000-0000-0000-000000000005','restore','admin');
end $$;
reset role;

select set_config('request.jwt.claims','{"wallet":"admin"}',true);
set local role authenticated;
do $$
begin
  perform pg_temp.reject('delete from workgroups','42501');
  perform pg_temp.reject('update workgroups set archived_at=null','42501');
  perform pg_temp.reject('update workgroups set has_activity=false','42501');
  perform pg_temp.reject('select change_workgroup_lifecycle(''20000000-0000-0000-0000-000000000001'',''restore'',''admin'')','42501');
  if (select count(*) from workgroups where archived_at is not null) <> 2 then raise exception 'Archived history not readable'; end if;
  update tasks set title='RLS bypass attempt' where workgroup_id='20000000-0000-0000-0000-000000000001';
  if exists(select 1 from tasks where title='RLS bypass attempt') then raise exception 'Archived task editable through RLS'; end if;
  insert into workgroups(community_id,name) values('10000000-0000-0000-0000-000000000000','Still can create');
  update workgroups set description='Still can edit' where name='Still can create';
end $$;
reset role;
rollback;
\echo Workgroup lifecycle tests passed.
