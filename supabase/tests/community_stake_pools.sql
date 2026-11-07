-- Migration 0099: community stake pools, float purpose, pool-reward inflow
-- classification. Run with psql -f against an EMPTY disposable PostgreSQL
-- database; everything is rolled back.
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
\ir ../migrations/0095_legacy_receipts.sql
\ir ../migrations/0096_verified_legacy_import.sql
\ir ../migrations/0097_legacy_import_stage_guards.sql
\ir ../migrations/0098_treasury_import_drafts.sql
\ir ../migrations/0099_community_stake_pools.sql
\ir ../migrations/0100_stake_pool_icon.sql

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
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00');

insert into funding_sources(id, community_id, name, created_by) values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Pool SIG rewards', 'admin');

insert into community_stake_pools(
  id, community_id, pool_id, ticker, margin, fixed_cost, reward_address, owners,
  icon_url, funding_source_id, created_by
) values (
  '60000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000000',
  'pool1sig',
  'SIG',
  0.02,
  '340000000',
  'stake_test1_reward',
  array['stake_test1_owner'],
  'https://cdn.example/sig.png',
  '50000000-0000-0000-0000-000000000001',
  'admin'
);

-- icon_url length check (≤ 512)
select pg_temp.reject(
  $q$update community_stake_pools set icon_url = 'https://x.example/' || repeat('a', 500)
    where id = '60000000-0000-0000-0000-000000000001'$q$,
  '23514'
);

insert into stake_pool_wallets(stake_pool_id, role, address) values
  ('60000000-0000-0000-0000-000000000001', 'reward_account', 'stake_test1_reward'),
  ('60000000-0000-0000-0000-000000000001', 'owner', 'stake_test1_owner');

-- DEX float default purpose; pool_rewards float for buffer.
insert into float_wallets(id, community_id, name, address, purpose, created_by) values
  ('a0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'DEX', 'addr_dex', 'dex', 'admin'),
  ('a0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Rewards buffer', 'addr_buffer', 'pool_rewards', 'admin');

insert into stake_pool_wallets(stake_pool_id, role, float_wallet_id) values
  ('60000000-0000-0000-0000-000000000001', 'rewards_buffer', 'a0000000-0000-0000-0000-000000000002');
insert into stake_pool_wallets(stake_pool_id, role, treasury_id) values
  ('60000000-0000-0000-0000-000000000001', 'community_treasury', '40000000-0000-0000-0000-000000000001');

-- DEX float cannot be a rewards buffer.
select pg_temp.reject(
  $q$insert into stake_pool_wallets(stake_pool_id, role, float_wallet_id) values
    ('60000000-0000-0000-0000-000000000001', 'rewards_buffer', 'a0000000-0000-0000-0000-000000000001')$q$,
  '23514'
);

-- Buffer → treasury inflow: tag as transfer then promote to pool revenue.
insert into incoming_txs(tx_hash, treasury_id, from_addresses, amount_lovelace, block_time, incoming_type, requires_reconciliation, matched) values
  ('pool_fwd', '40000000-0000-0000-0000-000000000001', '{addr_buffer}', 5000000, now(), 'unclassified', true, false);
insert into float_external_txs(tx_hash, float_wallet_id, block_height, block_time, fee_lovelace, amount_lovelace, to_addresses) values
  ('pool_fwd', 'a0000000-0000-0000-0000-000000000002', 1, now(), 200000, 5000000, '{addr_main}');

set local role service_role;
do $$
declare
  tagged integer;
  classified integer;
  pool uuid := '60000000-0000-0000-0000-000000000001';
  src uuid := '50000000-0000-0000-0000-000000000001';
  buf uuid := 'a0000000-0000-0000-0000-000000000002';
begin
  tagged := tag_float_transfers('10000000-0000-0000-0000-000000000000');
  if tagged < 1 then
    raise exception 'Expected float→treasury tag, got %', tagged;
  end if;
  if not exists (
    select 1 from incoming_txs
    where tx_hash = 'pool_fwd' and from_float_wallet_id = buf and incoming_type = 'transfer'
  ) then
    raise exception 'Buffer forward must first tag as transfer';
  end if;

  classified := classify_pool_reward_inflows('10000000-0000-0000-0000-000000000000');
  if classified <> 1 then
    raise exception 'Expected 1 pool reward classification, got %', classified;
  end if;
  if not exists (
    select 1 from incoming_txs
    where tx_hash = 'pool_fwd'
      and incoming_type = 'revenue'
      and funding_source_id = src
      and stake_pool_id = pool
      and from_float_wallet_id = buf
      and not requires_reconciliation
      and matched
  ) then
    raise exception 'Buffer→treasury must become pool revenue with funding source';
  end if;
end $$;

-- Members can read pools; anon cannot.
set local role authenticated;
set request.jwt.claims = '{"wallet":"member"}';
do $$
begin
  if (select count(*) from community_stake_pools) <> 1 then
    raise exception 'Members must read community stake pools';
  end if;
  if (select count(*) from stake_pool_wallets) < 4 then
    raise exception 'Members must read stake pool wallets';
  end if;
end $$;

set local role anon;
select pg_temp.reject($q$select count(*) from community_stake_pools$q$, '42501');

rollback;
