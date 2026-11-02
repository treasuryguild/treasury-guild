-- Migration 0088: watched float wallets and treasury↔float transfer tagging.
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
insert into communities(id, slug, name, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00');
insert into float_wallets(id, community_id, name, address, created_by) values
  ('a0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'DEX float', 'addr_float', 'admin');

insert into incoming_txs(tx_hash, treasury_id, from_addresses, amount_lovelace, block_time, incoming_type, requires_reconciliation, matched) values
  ('t1', '40000000-0000-0000-0000-000000000001', '{addr_bridge}', 5000000, now(), 'contribution', false, true),
  ('t2', '40000000-0000-0000-0000-000000000001', '{addr_x}', 1000000, now(), 'unclassified', true, false);
insert into float_incoming_txs(tx_hash, float_wallet_id, from_addresses, amount_lovelace, block_time) values
  ('f1', 'a0000000-0000-0000-0000-000000000001', '{addr_eth_bridge}', 8000000, now()),
  ('f2', 'a0000000-0000-0000-0000-000000000001', '{addr_x}', 1000000, now());

set local role service_role;

-- Treasury attach.
insert into incoming_conversions(id, community_id, kind, incoming_tx_hash, sent_amount, sent_asset_label, sent_chain, created_by)
  values ('c0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
    'bridge', 't1', '100', 'FET', 'ethereum', 'admin');
insert into incoming_conversion_fees(conversion_id, kind, amount, asset_label, chain, position)
  values ('c0000000-0000-0000-0000-000000000001', 'gas', '0.002', 'ETH', 'ethereum', 0);
insert into incoming_conversion_proofs(conversion_id, chain, tx_hash, label, position)
  values ('c0000000-0000-0000-0000-000000000001', 'ethereum', '0xabc', 'Eth send', 0);

-- Float attach.
insert into incoming_conversions(id, community_id, kind, float_incoming_tx_hash, sent_amount, sent_asset_label, sent_chain, created_by)
  values ('c0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000',
    'swap', 'f1', '50', 'FET', 'cardano', 'admin');

-- Duplicate treasury attach refused.
select pg_temp.reject(
  $q$insert into incoming_conversions(community_id, kind, incoming_tx_hash, sent_amount, sent_asset_label, sent_chain, created_by)
     values ('10000000-0000-0000-0000-000000000000', 'bridge', 't1', '1', 'ADA', 'cardano', 'admin')$q$,
  '23505'
);

-- XOR: both attach FKs refused.
select pg_temp.reject(
  $q$insert into incoming_conversions(community_id, kind, incoming_tx_hash, float_incoming_tx_hash, sent_amount, sent_asset_label, sent_chain, created_by)
     values ('10000000-0000-0000-0000-000000000000', 'bridge', 't2', 'f2', '1', 'ADA', 'cardano', 'admin')$q$,
  '23514'
);

-- Neither attach refused.
select pg_temp.reject(
  $q$insert into incoming_conversions(community_id, kind, sent_amount, sent_asset_label, sent_chain, created_by)
     values ('10000000-0000-0000-0000-000000000000', 'bridge', '1', 'ADA', 'cardano', 'admin')$q$,
  '23514'
);

-- Cascade: deleting the inflow drops the episode.
delete from incoming_txs where tx_hash = 't1';
do $$
begin
  if exists (select 1 from incoming_conversions where id = 'c0000000-0000-0000-0000-000000000001') then
    raise exception 'Conversion must cascade with treasury inflow';
  end if;
  if exists (select 1 from incoming_conversion_fees where conversion_id = 'c0000000-0000-0000-0000-000000000001') then
    raise exception 'Fees must cascade with conversion';
  end if;
end $$;

reset role;

set local role authenticated;
do $$
begin
  begin
    insert into incoming_conversions(community_id, kind, incoming_tx_hash, sent_amount, sent_asset_label, sent_chain, created_by)
      values ('10000000-0000-0000-0000-000000000000', 'bridge', 't2', '1', 'ADA', 'cardano', 'admin');
    raise exception 'Browser role must not write conversions';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
\echo Incoming conversion tests passed.

