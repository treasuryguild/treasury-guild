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
  ('f1', '40000000-0000-0000-0000-000000000001', '{addr_float}', 2000000, now(), 'unclassified', true, false),
  ('f2', '40000000-0000-0000-0000-000000000001', '{addr_someone}', 1000000, now(), 'unclassified', true, false);
insert into external_txs(tx_hash, treasury_id, block_height, block_time, fee_lovelace, amount_lovelace, to_addresses) values
  ('e1', '40000000-0000-0000-0000-000000000001', 1, now(), 200000, 5000000, '{addr_float}'),
  ('e2', '40000000-0000-0000-0000-000000000001', 2, now(), 200000, 7000000, '{addr_someone}');
insert into float_incoming_txs(tx_hash, float_wallet_id, from_addresses, amount_lovelace, block_time) values
  ('e1', 'a0000000-0000-0000-0000-000000000001', '{addr_main}', 5000000, now());
insert into float_external_txs(tx_hash, float_wallet_id, block_height, block_time, fee_lovelace, amount_lovelace, to_addresses) values
  ('f1', 'a0000000-0000-0000-0000-000000000001', 3, now(), 200000, 2000000, '{addr_main}'),
  ('d1', 'a0000000-0000-0000-0000-000000000001', 4, now(), 200000, 1000000, '{addr_dex}');

set local role service_role;
do $$
declare
  main uuid := '40000000-0000-0000-0000-000000000001';
  float uuid := 'a0000000-0000-0000-0000-000000000001';
  tagged integer;
begin
  tagged := tag_float_transfers('10000000-0000-0000-0000-000000000000');
  if tagged < 4 then
    raise exception 'Expected at least 4 tagged rows, got %', tagged;
  end if;
  if not exists (select 1 from incoming_txs where tx_hash = 'f1' and from_float_wallet_id = float
      and incoming_type = 'transfer' and not requires_reconciliation and matched) then
    raise exception 'Treasury inflow from float must become a logged transfer';
  end if;
  if exists (select 1 from incoming_txs where tx_hash = 'f2'
      and (from_float_wallet_id is not null or incoming_type <> 'unclassified')) then
    raise exception 'Outside inflow must stay in review';
  end if;
  if (select to_float_wallet_id from external_txs where tx_hash = 'e1') is distinct from float
    or (select to_float_wallet_id from external_txs where tx_hash = 'e2') is not null then
    raise exception 'Treasury outs tagged only when the float is a recipient';
  end if;
  if (select from_treasury_id from float_incoming_txs where tx_hash = 'e1') is distinct from main then
    raise exception 'Float inflow from treasury must be linked';
  end if;
  if (select to_treasury_id from float_external_txs where tx_hash = 'f1') is distinct from main
    or (select to_treasury_id from float_external_txs where tx_hash = 'd1') is not null then
    raise exception 'Float outs tagged only when a treasury is a recipient';
  end if;
  if tag_float_transfers('10000000-0000-0000-0000-000000000000') <> 0 then
    raise exception 'Re-running float tagging must be a no-op';
  end if;
end $$;

-- Payment transfer XOR: float recipient needs null budget_month; cannot set both FKs.
insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state)
  values ('60000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
    'payment', 'c1', 'pay-float', 'admin', 2);
insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, recipient_float_wallet_id, label, unit, amount, budget_month)
  values ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
    '40000000-0000-0000-0000-000000000001', 'addr_float', 'a0000000-0000-0000-0000-000000000001',
    'DEX float', 'lovelace', 1000000, null);

select pg_temp.reject(
  $q$insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, recipient_float_wallet_id, unit, amount, budget_month)
     values ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
       '40000000-0000-0000-0000-000000000001', 'addr_float2', 'a0000000-0000-0000-0000-000000000001',
       'lovelace', 1000000, '2026-01-01')$q$,
  '23514'
);
select pg_temp.reject(
  $q$insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, recipient_treasury_id, recipient_float_wallet_id, unit, amount, budget_month)
     values ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
       '40000000-0000-0000-0000-000000000001', 'addr_x',
       '40000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
       'lovelace', 1000000, null)$q$,
  '23514'
);

reset role;

set local role authenticated;
do $$
begin
  begin
    perform tag_float_transfers('10000000-0000-0000-0000-000000000000');
    raise exception 'Browser role must not tag float transfers';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
\echo Float wallet tests passed.
