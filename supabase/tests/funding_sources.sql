-- Migration 0052: funding sources, commitments, schedules and tagged inflows.
-- Run with psql -f against an EMPTY disposable PostgreSQL database; everything
-- is rolled back.
\set ON_ERROR_STOP on
begin;
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
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
\ir ../migrations/0039_call_capture.sql
\ir ../migrations/0040_call_sessions.sql
\ir ../migrations/0041_github_task_delete.sql
\ir ../migrations/0042_call_pending_sessions.sql
\ir ../migrations/0043_call_meeting_links.sql
\ir ../migrations/0044_meet_meeting_links.sql
\ir ../migrations/0045_chain_import.sql
\ir ../migrations/0046_security_hardening.sql
\ir ../migrations/0047_zoom_webhook_deliveries.sql
\ir ../migrations/0048_hide_platform_ids.sql
\ir ../migrations/0049_task_payable_on_insert.sql
\ir ../migrations/0050_legacy_history.sql
\ir ../migrations/0051_budget_backfill.sql
\ir ../migrations/0052_funding_sources.sql

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;
grant execute on function pg_temp.reject(text, text) to anon, authenticated, service_role;

insert into contributors(wallet_address) values ('admin'), ('member'), ('outsider');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'Other', 0, 'outsider');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member'),
  ('10000000-0000-0000-0000-000000000009', 'outsider', 'owner');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Dev', 0, 1, 'addr_dev', '00'),
  ('40000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000009', 'Theirs', 0, 1, 'addr_theirs', '00');

create function pg_temp.ada(value text) returns jsonb language sql as
  $$ select jsonb_build_array(jsonb_build_object('unit', 'lovelace', 'amount', value, 'asset_label', 'ADA', 'decimals', 6)) $$;

insert into funding_sources(id, community_id, name, created_by) values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Mother treasury', 'admin'),
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Project Catalyst', 'admin'),
  ('50000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000009', 'Theirs', 'outsider');
insert into funding_commitments(id, source_id, community_id, name, kind, cadence, starts_on, ends_on, amounts, created_by) values
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
   'Monthly allocation', 'recurring', 'monthly', '2026-01-01', '2026-12-01', pg_temp.ada('20000000000'), 'admin'),
  ('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
   'Release plan', 'schedule', 'monthly', null, null, '[]', 'admin'),
  ('60000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000',
   'Proposal F12', 'one_off', null, '2026-05-01', null, pg_temp.ada('50000000000'), 'admin');

-- 1. Commitment shapes.
select pg_temp.reject($q$ insert into funding_sources(community_id, name, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'MOTHER TREASURY', 'admin') $q$, '23505');
select pg_temp.reject($q$ insert into funding_commitments(source_id, community_id, name, kind, cadence, amounts, created_by)
  values ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'x', 'one_off', 'monthly', pg_temp.ada('1'), 'admin') $q$, '23514');
select pg_temp.reject($q$ insert into funding_commitments(source_id, community_id, name, kind, cadence, starts_on, amounts, created_by)
  values ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'x', 'recurring', 'quarterly', '2026-02-01', pg_temp.ada('1'), 'admin') $q$, '23514');
select pg_temp.reject($q$ insert into funding_commitments(source_id, community_id, name, kind, cadence, starts_on, ends_on, amounts, created_by)
  values ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'x', 'recurring', 'monthly', '2026-06-01', '2026-01-01', pg_temp.ada('1'), 'admin') $q$, '23514');
select pg_temp.reject($q$ insert into funding_commitments(source_id, community_id, name, kind, cadence, amounts, created_by)
  values ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'x', 'schedule', 'monthly', pg_temp.ada('1'), 'admin') $q$, '23514');
select pg_temp.reject($q$ insert into funding_commitments(source_id, community_id, name, kind, amounts, created_by)
  values ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'x', 'one_off', '[{"unit":"lovelace","amount":"1.5","decimals":6}]', 'admin') $q$, '23514');
-- A commitment's community is its source's.
select pg_temp.reject($q$ insert into funding_commitments(source_id, community_id, name, kind, amounts, created_by)
  values ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000009', 'x', 'one_off', pg_temp.ada('1'), 'admin') $q$, '23503');

-- 2. Schedules are replaced whole.
do $$
begin
  if save_funding_schedule('60000000-0000-0000-0000-000000000002', jsonb_build_array(
      jsonb_build_object('startsOn', '2026-01-01', 'amounts', pg_temp.ada('225000000000')),
      jsonb_build_object('startsOn', '2026-02-01', 'amounts', pg_temp.ada('221625000000')))) <> 2 then
    raise exception 'schedule periods not saved';
  end if;
end $$;
select pg_temp.reject($q$ select save_funding_schedule('60000000-0000-0000-0000-000000000002', jsonb_build_array(
  jsonb_build_object('startsOn', '2026-03-01', 'amounts', pg_temp.ada('1')),
  jsonb_build_object('startsOn', '2026-04-15', 'amounts', pg_temp.ada('1')))) $q$, '23514');
select pg_temp.reject($q$ select save_funding_schedule('60000000-0000-0000-0000-000000000001', '[]'::jsonb) $q$, '23514');
do $$ begin
  if (select count(*) from funding_commitment_periods) <> 2 then
    raise exception 'a refused schedule save changed the schedule';
  end if;
end $$;

-- 3. Tagging inflows.
insert into incoming_txs(tx_hash, treasury_id, amount_lovelace, block_time) values
  ('in1', '40000000-0000-0000-0000-000000000001', 20000000000, '2026-01-20'),
  ('in2', '40000000-0000-0000-0000-000000000001', 50000000000, '2026-05-02'),
  ('in3', '40000000-0000-0000-0000-000000000002', 1000000, '2026-05-03');
update incoming_txs set funding_source_id = '50000000-0000-0000-0000-000000000001',
  funding_commitment_id = '60000000-0000-0000-0000-000000000001' where tx_hash = 'in1';
update incoming_txs set funding_source_id = '50000000-0000-0000-0000-000000000002',
  funding_commitment_id = '60000000-0000-0000-0000-000000000003' where tx_hash = 'in2';
select pg_temp.reject($q$ update incoming_txs set funding_source_id = '50000000-0000-0000-0000-000000000009' where tx_hash = 'in3' $q$, '23514');
select pg_temp.reject($q$ update incoming_txs set funding_source_id = '50000000-0000-0000-0000-000000000002',
  funding_commitment_id = '60000000-0000-0000-0000-000000000001' where tx_hash = 'in3' $q$, '23514');
update incoming_txs set funding_source_id = null, funding_commitment_id = '60000000-0000-0000-0000-000000000001' where tx_hash = 'in3';
do $$ begin
  if (select funding_commitment_id from incoming_txs where tx_hash = 'in3') is not null then
    raise exception 'a commitment without its source was kept';
  end if;
end $$;
-- A transfer cannot be tagged; an inflow found to be a transfer loses its tag.
update incoming_txs set from_treasury_id = '40000000-0000-0000-0000-000000000001' where tx_hash = 'in3';
select pg_temp.reject($q$ update incoming_txs set funding_source_id = '50000000-0000-0000-0000-000000000001' where tx_hash = 'in3' $q$, '23514');
update incoming_txs set from_treasury_id = '40000000-0000-0000-0000-000000000002' where tx_hash = 'in1';
do $$ begin
  if (select funding_source_id from incoming_txs where tx_hash = 'in1') is not null then
    raise exception 'a transfer kept its funding tag';
  end if;
end $$;

-- 4. Deletes: a commitment leaves the inflow on its source; a source untags it.
delete from funding_commitments where id = '60000000-0000-0000-0000-000000000003';
do $$ begin
  if (select funding_source_id::text || '/' || coalesce(funding_commitment_id::text, '-') from incoming_txs where tx_hash = 'in2')
      <> '50000000-0000-0000-0000-000000000002/-' then
    raise exception 'deleting a commitment did not keep the source';
  end if;
end $$;
delete from funding_sources where id = '50000000-0000-0000-0000-000000000002';
do $$ begin
  if (select funding_source_id from incoming_txs where tx_hash = 'in2') is not null then
    raise exception 'deleting a source did not untag its inflows';
  end if;
  if not exists (select 1 from incoming_txs where tx_hash = 'in2') then
    raise exception 'deleting a source removed an inflow';
  end if;
end $$;

-- 5. Members read; nobody writes from the browser.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
do $$ begin
  if (select count(*) from funding_sources) <> 1 or (select count(*) from funding_commitments) <> 2
     or (select count(*) from funding_commitment_periods) <> 2 then
    raise exception 'a member does not see exactly their community''s funding';
  end if;
end $$;
select pg_temp.reject($q$ insert into funding_sources(community_id, name, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'Sneaky', 'member') $q$, '42501');
select pg_temp.reject($q$ update funding_commitments set name = 'x' $q$, '42501');
select pg_temp.reject($q$ select save_funding_schedule('60000000-0000-0000-0000-000000000002', '[]'::jsonb) $q$, '42501');
reset role;
set local role anon;
select pg_temp.reject($q$ select * from funding_sources $q$, '42501');
reset role;

rollback;
\echo Funding sources tests passed.
