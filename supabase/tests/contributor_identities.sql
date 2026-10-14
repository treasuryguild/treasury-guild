-- Migration 0038: linked Discord / Google accounts. Run with psql -f against an
-- EMPTY disposable PostgreSQL database; everything is rolled back.
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
\ir ../migrations/0027_discord_webhooks.sql
\ir ../migrations/0028_discord_rate.sql
\ir ../migrations/0029_budget_current_period.sql
\ir ../migrations/0030_community_spending_unit.sql
\ir ../migrations/0031_sync_cursor_synced_at.sql
\ir ../migrations/0032_external_txs.sql
\ir ../migrations/0033_paid_columns.sql
\ir ../migrations/0034_internal_transfers.sql
\ir ../migrations/0035_workgroup_treasury_assignments.sql
\ir ../migrations/0036_payments_treasury_budgets.sql
\ir ../migrations/0037_calls.sql
\ir ../migrations/0038_contributor_identities.sql

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

insert into contributors(wallet_address) values ('alice'), ('bob');
insert into contributor_identities(wallet_address, provider, external_id, display_name) values
  ('alice', 'discord', '111', 'alice#1'), ('alice', 'google', 'g-1', null);

-- One account per provider per wallet, one wallet per account, known providers only.
select pg_temp.reject($$insert into contributor_identities(wallet_address, provider, external_id) values ('alice', 'discord', '222')$$, '23505');
select pg_temp.reject($$insert into contributor_identities(wallet_address, provider, external_id) values ('bob', 'discord', '111')$$, '23505');
select pg_temp.reject($$insert into contributor_identities(wallet_address, provider, external_id) values ('bob', 'zoom', 'z-1')$$, '23514');
select pg_temp.reject($$insert into contributor_identities(wallet_address, provider, external_id) values ('bob', 'google', '')$$, '23514');
-- The same id on another provider is another account.
insert into contributor_identities(wallet_address, provider, external_id) values ('bob', 'google', '111');

-- A wallet reads its own links only, and never writes them.
set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claims', '{"wallet":"alice"}', true);
  if (select count(*) from contributor_identities) <> 2 then raise exception 'Owner cannot read own identities'; end if;
  if exists (select 1 from contributor_identities where wallet_address <> 'alice') then
    raise exception 'Another wallet''s identity is visible'; end if;
  perform pg_temp.reject($q$insert into contributor_identities(wallet_address, provider, external_id) values ('alice', 'discord', '999')$q$, '42501');
  perform pg_temp.reject($q$update contributor_identities set external_id = '999'$q$, '42501');
  perform pg_temp.reject($q$delete from contributor_identities$q$, '42501');
  perform set_config('request.jwt.claims', '{}', true);
  if (select count(*) from contributor_identities) <> 0 then raise exception 'Signed-out read leaks identities'; end if;
end $$;
reset role;
set local role anon;
select pg_temp.reject('select * from contributor_identities', '42501');
reset role;

-- Deleting the contributor removes the links.
delete from contributors where wallet_address = 'bob';
do $$ begin
  if exists (select 1 from contributor_identities where wallet_address = 'bob') then
    raise exception 'Identity survived its contributor'; end if;
end $$;

rollback;
\echo Contributor identity tests passed.
