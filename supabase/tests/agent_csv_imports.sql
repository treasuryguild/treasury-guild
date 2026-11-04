-- Migration 0093: agent CSV imports.
-- Run with psql -f against an EMPTY disposable PostgreSQL database; rolled back.
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
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
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
\ir ../migrations/0060_anchors.sql
\ir ../migrations/0061_treasury_templates.sql
\ir ../migrations/0062_atomic_tx_state.sql
\ir ../migrations/0063_route_hardening.sql
\ir ../migrations/0064_agent_proposal_drafts.sql
\ir ../migrations/0065_agent_drafts.sql
\ir ../migrations/0066_github_multi_install.sql
\ir ../migrations/0067_github_document_store.sql
\ir ../migrations/0068_proposal_replaces.sql
\ir ../migrations/0069_primary_treasury.sql
\ir ../migrations/0070_anchor_alerts.sql
\ir ../migrations/0071_governance_discord_channels.sql
\ir ../migrations/0072_treasury_discord_destinations.sql
\ir ../migrations/0073_community_invites.sql
\ir ../migrations/0074_treasury_lifecycle.sql
\ir ../migrations/0075_sdk_staking_drep.sql
\ir ../migrations/0076_registration_tx_kind.sql
\ir ../migrations/0077_treasury_signer_drafts.sql
\ir ../migrations/0078_reconcile_refund_cap.sql
\ir ../migrations/0079_future_budget_month.sql
\ir ../migrations/0080_confirm_pending_on_chain.sql
\ir ../migrations/0081_assignee_github_user_id.sql
\ir ../migrations/0082_p2_hardening.sql
\ir ../migrations/0083_lead_changes.sql
\ir ../migrations/0084_signed_delete_and_task_claim.sql
\ir ../migrations/0085_canceled_tx_ttl.sql
\ir ../migrations/0086_external_tx_activity.sql
\ir ../migrations/0087_external_tx_cbor.sql
\ir ../migrations/0088_float_wallets.sql
\ir ../migrations/0089_incoming_conversions.sql
\ir ../migrations/0090_float_sync_from.sql
\ir ../migrations/0091_payday_allocation_rules.sql
\ir ../migrations/0092_recognition.sql
\ir ../migrations/0093_agent_csv_imports.sql
\ir ../migrations/0094_legacy_history_row_cap.sql

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

insert into contributors(wallet_address) values ('admin'), ('member');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member');

-- Authenticated has no grant on the payload table or the import functions.
set role authenticated;
select pg_temp.reject($q$ select * from agent_import_payloads $q$, '42501');
select pg_temp.reject($q$ select import_agent_legacy_history('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '10000000-0000-0000-0000-000000000000', 'admin', 'h.csv', null, 'Old', null, '[]'::jsonb, '[]'::jsonb, true) $q$, '42501');
select pg_temp.reject($q$ select import_agent_funding_schedule('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '10000000-0000-0000-0000-000000000000', 'admin', null, 'F', null, null, null, 'S', 'monthly', '[]'::jsonb) $q$, '42501');
reset role;

-- Expired previews go; a fresh one stays.
insert into agent_import_payloads(community_id, wallet, kind, csv, mapping, expires_at) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'legacy_history', 'a', '{}', now() - interval '1 minute'),
  ('10000000-0000-0000-0000-000000000000', 'admin', 'funding_schedule', 'b', '{}', now() + interval '1 hour');
do $$
begin
  if purge_agent_import_payloads(now()) <> 1 then raise exception 'purge count'; end if;
  if (select count(*) from agent_import_payloads) <> 1 then raise exception 'fresh payload was deleted'; end if;
end $$;

-- Payment history: one draft creates the wallet, the workgroup and the rows; a second reads them back.
do $$
declare r jsonb;
begin
  r := import_agent_legacy_history(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '10000000-0000-0000-0000-000000000000', 'admin', 'history.csv',
    null, 'Old wallet', null,
    jsonb_build_array(jsonb_build_object('ref', 'design', 'action', 'create', 'displayName', 'Design')),
    jsonb_build_array(jsonb_build_object(
      'lineNo', 2, 'workgroupId', '00000000-0000-0000-0000-000000000000', 'workgroupRef', 'design',
      'recipientRef', 'f39ntm', 'task', 'Poster', 'paidOn', '2026-09-15', 'budgetMonth', '2026-09-01',
      'dedupeKey', repeat('a', 64),
      'amounts', jsonb_build_array(jsonb_build_object('unit', 'lovelace', 'ticker', 'ADA', 'decimals', 6, 'amount', '10000000'))
    )),
    true);
  if (r->>'created')::boolean is not true or (r->>'inserted')::int <> 1 then
    raise exception 'history create returned %', r;
  end if;
  if (select count(*) from legacy_wallets) <> 1 or (select count(*) from workgroups) <> 1
    or (select count(*) from board_columns) <> 5 or (select count(*) from legacy_payments) <> 1 then
    raise exception 'history rows were not written once';
  end if;
  if (select workgroup_id::text from workgroup_import_aliases where name = 'design')
    is distinct from (select id::text from workgroups where name = 'Design') then
    raise exception 'alias was not stored';
  end if;
  r := import_agent_legacy_history(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '10000000-0000-0000-0000-000000000000', 'admin', 'history.csv',
    null, 'Old wallet', null, '[]'::jsonb, '[]'::jsonb, true);
  if (r->>'created')::boolean is not false or (select count(*) from legacy_payments) <> 1 then
    raise exception 'history replay returned %', r;
  end if;
end $$;

select pg_temp.reject($q$ select import_agent_legacy_history('cccccccccccccccccccccccccccccccc', '10000000-0000-0000-0000-000000000000', 'member', 'h.csv', null, 'Other', null, '[]'::jsonb, jsonb_build_array(jsonb_build_object('lineNo', 2, 'workgroupRef', 'design', 'recipientRef', 'f39ntm', 'task', 'T', 'paidOn', '2026-09-15', 'budgetMonth', '2026-09-01', 'dedupeKey', repeat('b', 64), 'amounts', jsonb_build_array(jsonb_build_object('unit', 'lovelace', 'ticker', 'ADA', 'decimals', 6, 'amount', '1')))) , true) $q$, '42501');

insert into governance_settings(community_id, kind, enabled, proposers, electorate, method, quorum_pct,
  threshold_pct, discussion_hours, voting_hours, updated_by)
  values ('10000000-0000-0000-0000-000000000000', 'workgroup', true, 'members', 'members', 'majority', 20, 50, 48, 120, 'admin');
select pg_temp.reject($q$ select import_agent_legacy_history('dddddddddddddddddddddddddddddddd', '10000000-0000-0000-0000-000000000000', 'admin', 'h.csv', null, 'Another', null, jsonb_build_array(jsonb_build_object('ref', 'ops', 'action', 'create', 'displayName', 'Ops')), jsonb_build_array(jsonb_build_object('lineNo', 2, 'workgroupRef', 'ops', 'recipientRef', 'f39ntm', 'task', 'T', 'paidOn', '2026-09-15', 'budgetMonth', '2026-09-01', 'dedupeKey', repeat('c', 64), 'amounts', jsonb_build_array(jsonb_build_object('unit', 'lovelace', 'ticker', 'ADA', 'decimals', 6, 'amount', '1')))), true) $q$, '23514');

-- Funding: one draft creates the source, the schedule and its period; a second reads it back.
do $$
declare r jsonb;
begin
  r := import_agent_funding_schedule(
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '10000000-0000-0000-0000-000000000000', 'admin',
    null, 'Catalyst', 'A funder', 'https://example.com',
    null, 'Wave 1', 'monthly',
    jsonb_build_array(jsonb_build_object(
      'startsOn', '2026-03-01',
      'amounts', jsonb_build_array(jsonb_build_object('unit', 'lovelace', 'amount', '12500000', 'asset_label', 'ADA', 'decimals', 6))
    )));
  if (r->>'created')::boolean is not true or (r->>'periods')::int <> 1 then
    raise exception 'schedule create returned %', r;
  end if;
  if (select count(*) from funding_sources) <> 1 or (select count(*) from funding_commitment_periods) <> 1 then
    raise exception 'schedule rows were not written once';
  end if;
  r := import_agent_funding_schedule(
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '10000000-0000-0000-0000-000000000000', 'admin',
    null, null, null, null, null, null, 'monthly', '[]'::jsonb);
  if (r->>'created')::boolean is not false or (select count(*) from funding_sources) <> 1
    or (select count(*) from funding_commitment_periods) <> 1 then
    raise exception 'schedule replay returned %', r;
  end if;
end $$;

rollback;

