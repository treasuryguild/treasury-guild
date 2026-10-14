-- Run with psql -f against an EMPTY disposable PostgreSQL database.
-- Everything, including the schema and roles, is rolled back.
-- Asserts 0026: a treasury's network must match its community's network.
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
\ir ../migrations/0024_task_assignees.sql
\ir ../migrations/0025_drop_contributor_balances.sql
\ir ../migrations/0026_treasury_network_matches_community.sql

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
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'preprod-guild', 'Preprod guild', 0, 'admin'),
  ('10000000-0000-0000-0000-000000000001', 'mainnet-guild', 'Mainnet guild', 1, 'admin');

-- Matching networks insert fine on both sides.
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000000', 'Preprod wallet', 0, 1, 'addr_test1preprod', '00'),
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Mainnet wallet', 1, 1, 'addr1mainnet', '00');

-- A mainnet treasury under a preprod community (and the reverse) is refused.
select pg_temp.reject($$
  insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
    ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Wrong wallet', 1, 1, 'addr1wrong', '00')
$$, '23514');
select pg_temp.reject($$
  insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
    ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Wrong wallet', 0, 1, 'addr_test1wrong', '00')
$$, '23514');

-- Flipping an existing treasury's network, or moving it to a community on
-- the other network, is refused too.
select pg_temp.reject($$
  update treasuries set network = 1 where id = '40000000-0000-0000-0000-000000000000'
$$, '23514');
select pg_temp.reject($$
  update treasuries set community_id = '10000000-0000-0000-0000-000000000001'
  where id = '40000000-0000-0000-0000-000000000000'
$$, '23514');

-- Unrelated updates on a treasury are untouched by the guard.
update treasuries set name = 'Renamed' where id = '40000000-0000-0000-0000-000000000000';

-- A treasury for a community that does not exist: the guard runs before the
-- FK check and reports the missing community itself.
select pg_temp.reject($$
  insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
    ('40000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-00000000dead', 'Orphan', 0, 1, 'addr_test1orphan', '00')
$$, 'P0002');

do $$
begin
  if (select count(*) from treasuries) <> 2 then
    raise exception 'Expected exactly the two matching treasuries';
  end if;
end $$;

select 'Treasury network tests passed (all changes rolled back).' as result;
rollback;
