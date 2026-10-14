-- Migration 0048: members read call presence and connected platforms, but not
-- the platform account ids behind them. Run with psql -f against an EMPTY
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

insert into contributors(wallet_address) values ('addr_test_admin'), ('addr_test_member'), ('addr1bob');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'addr_test_admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'addr_test_admin', 'admin'),
  ('10000000-0000-0000-0000-000000000000', 'addr_test_member', 'member');
insert into workgroups(id, community_id, name) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Calls');
insert into calls(id, community_id, workgroup_id, provider, title, external_ref, starts_at, ends_at, amounts, min_minutes, created_by) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
   '20000000-0000-0000-0000-000000000001', 'zoom', 'Town hall', '81234567890',
   '2026-09-01 17:00+00', '2026-09-01 18:00+00', '{"ADA":"5"}', 30, 'addr_test_admin');
insert into call_attendees(id, call_id, provider, external_id, display_name) values
  ('70000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'zoom', 'zoom-user-1', 'Alice');
insert into call_attendee_sessions(attendee_id, joined_at, left_at, source_key) values
  ('70000000-0000-0000-0000-000000000001', '2026-09-01 17:00+00', '2026-09-01 17:40+00', 'zoom:rp:zoom-user-1:2026-09-01T17:00:00.000Z');
insert into call_integrations(community_id, provider, external_account_id, label, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'google', 'google-sub-1', 'Host', 'addr_test_admin');

set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claims', '{"wallet":"addr_test_member"}', true);
  -- Presence and the connection itself stay readable.
  if (select count(*) from call_attendee_sessions where left_at is not null) <> 1 then
    raise exception 'Member cannot read sessions';
  end if;
  if (select label from call_integrations where provider = 'google') is distinct from 'Host' then
    raise exception 'Member cannot read the connection';
  end if;
  -- The platform ids do not.
  perform pg_temp.reject('select source_key from call_attendee_sessions', '42501');
  perform pg_temp.reject('select * from call_attendee_sessions', '42501');
  perform pg_temp.reject('select external_account_id from call_integrations', '42501');
  perform pg_temp.reject('select * from call_integrations', '42501');
end $$;
reset role;

rollback;
\echo Platform id column grant tests passed.
