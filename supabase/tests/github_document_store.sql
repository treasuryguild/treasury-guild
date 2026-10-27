-- Migration 0067: GitHub as a document store for frozen tally publications
-- (archive repo on governance_community_settings, widened store checks).
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
\ir ../migrations/0053_mcp_oauth.sql
\ir ../migrations/0054_purge_oauth_cimd.sql
\ir ../migrations/0055_governance.sql
\ir ../migrations/0056_governance_workgroups_tasks.sql
\ir ../migrations/0057_governance_announcements.sql
\ir ../migrations/0058_add_signature_result.sql
\ir ../migrations/0059_anchoring_groundwork.sql
\ir ../migrations/0067_github_document_store.sql

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

insert into contributors(wallet_address) values ('admin');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin');
insert into community_members(community_id, wallet_address, role, created_at) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner', now() - interval '9 days');

do $$
declare
  c uuid := '10000000-0000-0000-0000-000000000000';
  since timestamptz;
  since2 timestamptz;
begin
  -- github without an archive repo is refused.
  perform pg_temp.reject(
    format('select save_governance_community_settings(%L, %L, %L)',
      c, '{"document_store": "github", "spend_check": "warn"}', 'admin'),
    '23514');

  perform save_governance_community_settings(c,
    '{"document_store": "github", "document_archive_repo_id": 42, "document_archive_full_name": "guild/archive", "spend_check": "warn"}',
    'admin');
  if (select document_store = 'github' and document_archive_repo_id = 42
        and document_archive_full_name = 'guild/archive' and document_store_since is not null
      from governance_community_settings where community_id = c) is not true then
    raise exception 'github store save wrong';
  end if;
  select document_store_since into since from governance_community_settings where community_id = c;

  -- Same store and repo keeps the stamp.
  perform save_governance_community_settings(c,
    '{"document_store": "github", "document_archive_repo_id": 42, "document_archive_full_name": "guild/archive", "spend_check": "refuse"}',
    'admin');
  if (select document_store_since from governance_community_settings where community_id = c) <> since then
    raise exception 'since moved without a repo change';
  end if;

  -- Changing the archive repo bumps since.
  perform save_governance_community_settings(c,
    '{"document_store": "github", "document_archive_repo_id": 99, "document_archive_full_name": "guild/other", "spend_check": "warn"}',
    'admin');
  select document_store_since into since2 from governance_community_settings where community_id = c;
  if since2 is null or since2 <= since then
    raise exception 'changing archive repo did not bump since';
  end if;

  -- Switching to ipfs clears the archive columns.
  perform save_governance_community_settings(c,
    '{"document_store": "ipfs", "spend_check": "warn"}', 'admin');
  if (select document_store = 'ipfs' and document_archive_repo_id is null
        and document_archive_full_name is null
      from governance_community_settings where community_id = c) is not true then
    raise exception 'ipfs did not clear archive columns';
  end if;

  perform pg_temp.reject(format('select save_governance_community_settings(%L, %L, %L)',
    c, '{"document_store": "arweave"}', 'admin'), '23514');
  -- github without archive columns is refused by the pairing check.
  perform pg_temp.reject(
    format('update governance_community_settings set document_store = %L where community_id = %L',
      'github', c),
    '23514');
end $$;

rollback;
