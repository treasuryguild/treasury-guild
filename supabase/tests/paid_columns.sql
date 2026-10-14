-- Migration 0033: Paid column backfill. Run with psql -f against an EMPTY
-- disposable PostgreSQL database; everything is rolled back.
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

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

insert into contributors(wallet_address) values ('admin');
insert into communities(id, slug, name, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'test-guild', 'Test guild', 'admin');
insert into community_members(community_id, wallet_address, role)
  values ('10000000-0000-0000-0000-000000000000', 'admin', 'admin');
-- A: active app board. B: archived app board. C: GitHub board. D: app board never set up.
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000000', 'Active', 'native'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000000', 'Archived', 'native'),
  ('20000000-0000-0000-0000-00000000000c', '10000000-0000-0000-0000-000000000000', 'GitHub', 'github'),
  ('20000000-0000-0000-0000-00000000000d', '10000000-0000-0000-0000-000000000000', 'Empty', 'native');
insert into board_columns(id, workgroup_id, name, position, marks_payable) values
  ('60000000-0000-0000-0000-0000000000a0', '20000000-0000-0000-0000-00000000000a', 'To Do', 0, false),
  ('60000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-00000000000a', 'In Progress', 1, false),
  ('60000000-0000-0000-0000-0000000000a2', '20000000-0000-0000-0000-00000000000a', 'Done', 2, false),
  ('60000000-0000-0000-0000-0000000000a3', '20000000-0000-0000-0000-00000000000a', 'Audited', 3, true),
  ('60000000-0000-0000-0000-0000000000b0', '20000000-0000-0000-0000-00000000000b', 'Audited', 0, true);
insert into tasks(id, workgroup_id, title, source, pay_state, audited, column_id) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-00000000000a', 'Paid', 'native', 'paid', true, '60000000-0000-0000-0000-0000000000a3'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-00000000000a', 'Reconciled', 'native', 'reconciled', true, '60000000-0000-0000-0000-0000000000a2'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-00000000000a', 'Payable', 'native', 'payable', true, '60000000-0000-0000-0000-0000000000a3'),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-00000000000a', 'Queued', 'native', 'queued', true, '60000000-0000-0000-0000-0000000000a3'),
  ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-00000000000a', 'Archived paid', 'native', 'paid', true, '60000000-0000-0000-0000-0000000000a3'),
  ('30000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-00000000000b', 'Paid on archived board', 'native', 'paid', true, '60000000-0000-0000-0000-0000000000b0'),
  ('30000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-00000000000c', 'GitHub paid', 'github', 'paid', true, null);
update tasks set archived_at = now() where id = '30000000-0000-0000-0000-000000000005';
update workgroups set archived_at = now() where id = '20000000-0000-0000-0000-00000000000b';
insert into github_installations(installation_id, community_id, account_login, account_type)
  values (1, '10000000-0000-0000-0000-000000000000', 'org', 'Organization');
insert into github_repos(id, installation_id, full_name, workgroup_id)
  values (100, 1, 'org/repo', '20000000-0000-0000-0000-00000000000c');

\ir ../migrations/0033_paid_columns.sql

do $$
declare paid_col uuid;
begin
  select id into paid_col from board_columns where workgroup_id = '20000000-0000-0000-0000-00000000000a' and marks_paid;
  if paid_col is null or (select count(*) from board_columns where marks_paid) <> 1 then
    raise exception 'Exactly one Paid column expected, on the active board only';
  end if;
  if not exists (select 1 from board_columns where id = paid_col and name = 'Paid' and position = 4 and not marks_payable) then
    raise exception 'Paid column must follow the last column and not mark payable';
  end if;
  if (select count(*) from board_columns) <> 6 then
    raise exception 'Archived, GitHub and empty boards must get no column';
  end if;
  if (select array_agg(id order by id) from tasks where column_id = paid_col) is distinct from
     array['30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002']::uuid[] then
    raise exception 'Only active paid/reconciled native tasks move into Paid';
  end if;
  if not exists (select 1 from tasks where id = '30000000-0000-0000-0000-000000000005'
      and column_id = '60000000-0000-0000-0000-0000000000a3' and archived_at is not null)
    or not exists (select 1 from tasks where id = '30000000-0000-0000-0000-000000000006'
      and column_id = '60000000-0000-0000-0000-0000000000b0')
    or not exists (select 1 from tasks where id = '30000000-0000-0000-0000-000000000007' and column_id is null) then
    raise exception 'Archived or non-native tasks must be left alone';
  end if;
  if (select paid_status from github_repos where id = 100) <> 'Paid' then
    raise exception 'Existing repo links default to the Paid status';
  end if;
  perform pg_temp.reject(
    'insert into board_columns(workgroup_id, name, position, marks_paid) values (''20000000-0000-0000-0000-00000000000a'', ''Paid again'', 9, true)',
    '23505');
end $$;

-- Re-running the backfill statements is a no-op (idempotent for repeated local applies).
insert into public.board_columns (workgroup_id, name, position, marks_paid)
select w.id, 'Paid', max(c.position) + 1, true
from public.workgroups w join public.board_columns c on c.workgroup_id = w.id
where w.kind = 'native' and w.archived_at is null
  and not exists (select 1 from public.board_columns p where p.workgroup_id = w.id and p.marks_paid)
group by w.id;
do $$ begin
  if (select count(*) from board_columns) <> 6 then raise exception 'Backfill not idempotent'; end if;
end $$;

rollback;
