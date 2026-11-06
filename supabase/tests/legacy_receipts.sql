-- Migration 0095: previous-wallet receipts.
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
\ir ../migrations/0095_legacy_receipts.sql
\ir ../migrations/0096_verified_legacy_import.sql
\ir ../migrations/0097_legacy_import_stage_guards.sql

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

insert into contributors(wallet_address) values ('admin'), ('member'), ('other');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'Other', 0, 'other');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'owner');
insert into legacy_wallets(id, community_id, name, address, created_by) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Old wallet',
   'addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2', 'admin'),
  ('30000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000009', 'Theirs',
   'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae', 'other');
insert into funding_sources(id, community_id, name, created_by) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Catalyst', 'admin'),
  ('40000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000009', 'Foreign', 'other');
insert into funding_commitments(id, source_id, community_id, name, kind, amounts, created_by) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
   'Fund 10', 'one_off', '[{"unit":"lovelace","amount":"1000000","asset_label":"ADA","decimals":6}]'::jsonb, 'admin'),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
   'Other', 'one_off', '[{"unit":"lovelace","amount":"1","asset_label":"ADA","decimals":6}]'::jsonb, 'admin');

create function pg_temp.line(
  n int, key text,
  src text default '40000000-0000-0000-0000-000000000001',
  cmt text default '50000000-0000-0000-0000-000000000001'
) returns jsonb language sql as $$
  select jsonb_build_object(
    'lineNo', n, 'receivedOn', '2024-09-15',
    'fundingSourceId', src, 'fundingCommitmentId', cmt,
    'note', 'Allocation ' || n, 'dedupeKey', lpad(key, 64, '0'),
    'txHash', lpad(to_hex(n), 64, 'b'),
    'outputIndex', 0,
    'amounts', jsonb_build_array(
      jsonb_build_object('unit', 'lovelace', 'ticker', 'ADA', 'decimals', 6, 'amount', '50000000000')))
$$;

-- 1. Import writes lines and amounts; untagged rows are allowed.
do $$
declare r jsonb;
begin
  r := import_legacy_receipts('30000000-0000-0000-0000-000000000001', 'receipts.csv', 'admin',
    jsonb_build_array(
      pg_temp.line(2, 'a'),
      pg_temp.line(3, 'b'),
      jsonb_build_object(
        'lineNo', 4, 'receivedOn', '2024-10-01', 'dedupeKey', lpad('d', 64, '0'),
        'txHash', lpad('d', 64, 'd'), 'outputIndex', 0,
        'amounts', jsonb_build_array(
          jsonb_build_object('unit', 'lovelace', 'ticker', 'ADA', 'decimals', 6, 'amount', '1000000')))));
  if (r->>'inserted')::int <> 3 or (r->>'skipped')::int <> 0 or (r->>'replaced')::boolean then
    raise exception 'first import returned %', r;
  end if;
  if (select count(*) from legacy_receipt_amounts) <> 3 then
    raise exception 'amounts were not written';
  end if;
  if (select count(*) from legacy_receipts where funding_source_id is null) <> 1 then
    raise exception 'untagged row missing';
  end if;
end $$;

-- 2. Re-import skips; includeDuplicates inserts again; all-duplicate refuses.
do $$
declare r jsonb;
begin
  r := import_legacy_receipts('30000000-0000-0000-0000-000000000001', 'more.csv', 'admin',
    jsonb_build_array(pg_temp.line(2, 'a'), pg_temp.line(3, 'c')));
  if (r->>'inserted')::int <> 1 or (r->>'skipped')::int <> 1 then
    raise exception 'second import returned %', r;
  end if;
  r := import_legacy_receipts('30000000-0000-0000-0000-000000000001', 'again.csv', 'admin',
    jsonb_build_array(pg_temp.line(2, 'a')), null, false);
  if (r->>'inserted')::int <> 1 then
    raise exception 'included duplicate skipped: %', r;
  end if;
end $$;
select pg_temp.reject($q$ select import_legacy_receipts('30000000-0000-0000-0000-000000000001', 'same.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'a'))) $q$, '23514');

-- 3. Replace swaps atomically.
do $$
declare
  old uuid;
  r jsonb;
begin
  select id into old from legacy_receipt_imports order by created_at limit 1;
  r := import_legacy_receipts('30000000-0000-0000-0000-000000000001', 'fixed.csv', 'admin',
    jsonb_build_array(pg_temp.line(2, 'e')), old);
  if not (r->>'replaced')::boolean or (r->>'inserted')::int <> 1 then
    raise exception 'replace returned %', r;
  end if;
  if exists (select 1 from legacy_receipt_imports where id = old) then
    raise exception 'old import survived replace';
  end if;
end $$;

-- 4. Auth and community checks.
select pg_temp.reject($q$ select import_legacy_receipts('30000000-0000-0000-0000-000000000001', 'x.csv', 'member',
  jsonb_build_array(pg_temp.line(2, 'e'))) $q$, '42501');
select pg_temp.reject($q$ select import_legacy_receipts('30000000-0000-0000-0000-000000000009', 'x.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'e'))) $q$, '42501');
select pg_temp.reject($q$ select import_legacy_receipts('30000000-0000-0000-0000-00000000dead', 'x.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'e'))) $q$, 'P0002');

-- 5. Foreign source / mismatched commitment refused.
select pg_temp.reject($q$ select import_legacy_receipts('30000000-0000-0000-0000-000000000001', 'x.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'f', '40000000-0000-0000-0000-000000000009', null))) $q$, '23514');
select pg_temp.reject($q$ select import_legacy_receipts('30000000-0000-0000-0000-000000000001', 'x.csv', 'admin',
  jsonb_build_array(jsonb_build_object(
    'lineNo', 2, 'receivedOn', '2024-09-15', 'fundingSourceId', '40000000-0000-0000-0000-000000000001',
    'fundingCommitmentId', '50000000-0000-0000-0000-00000000dead',
    'dedupeKey', lpad('dead', 64, '0'),
    'txHash', repeat('e', 64), 'outputIndex', 0,
    'amounts', jsonb_build_array(
      jsonb_build_object('unit', 'lovelace', 'ticker', 'ADA', 'decimals', 6, 'amount', '1'))))) $q$, '23514');
select pg_temp.reject($q$ select import_legacy_receipts('30000000-0000-0000-0000-000000000001', 'x.csv', 'admin',
  jsonb_build_array(jsonb_build_object(
    'lineNo', 2, 'receivedOn', '2024-09-15',
    'fundingCommitmentId', '50000000-0000-0000-0000-000000000001',
    'dedupeKey', lpad('abcdef', 64, '0'),
    'txHash', repeat('f', 64), 'outputIndex', 0,
    'amounts', jsonb_build_array(
      jsonb_build_object('unit', 'lovelace', 'ticker', 'ADA', 'decimals', 6, 'amount', '1'))))) $q$, '23514');

-- 6. Deleting a funding source clears the tag; wallet delete cascades.
update funding_sources set name = 'Catalyst renamed' where id = '40000000-0000-0000-0000-000000000001';
delete from funding_sources where id = '40000000-0000-0000-0000-000000000001';
do $$ begin
  if exists (select 1 from legacy_receipts where funding_source_id is not null) then
    raise exception 'source delete did not clear tags';
  end if;
end $$;

delete from legacy_wallets where id = '30000000-0000-0000-0000-000000000001';
do $$ begin
  if exists (select 1 from legacy_receipts) or exists (select 1 from legacy_receipt_imports) then
    raise exception 'wallet delete did not cascade';
  end if;
end $$;

-- 7. Agent import creates wallet and is idempotent on draft id.
do $$
declare r jsonb;
begin
  r := import_agent_legacy_receipts(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '10000000-0000-0000-0000-000000000000', 'admin',
    'agent.csv', null, 'From agent',
    'addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2',
    jsonb_build_array(jsonb_build_object(
      'lineNo', 2, 'receivedOn', '2024-01-01', 'dedupeKey', lpad('ae', 64, '0'),
      'txHash', repeat('1', 64), 'outputIndex', 0,
      'amounts', jsonb_build_array(
        jsonb_build_object('unit', 'lovelace', 'ticker', 'ADA', 'decimals', 6, 'amount', '42')))),
    true);
  if not (r->>'created')::boolean or (r->>'inserted')::int <> 1 then
    raise exception 'agent import returned %', r;
  end if;
  r := import_agent_legacy_receipts(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '10000000-0000-0000-0000-000000000000', 'admin',
    'agent.csv', null, 'From agent',
    'addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2',
    jsonb_build_array(jsonb_build_object(
      'lineNo', 2, 'receivedOn', '2024-01-01', 'dedupeKey', lpad('ae', 64, '0'),
      'txHash', repeat('1', 64), 'outputIndex', 0,
      'amounts', jsonb_build_array(
        jsonb_build_object('unit', 'lovelace', 'ticker', 'ADA', 'decimals', 6, 'amount', '42')))),
    true);
  if (r->>'created')::boolean or (r->>'inserted')::int <> 1 then
    raise exception 'agent replay returned %', r;
  end if;
end $$;
select pg_temp.reject($q$ select import_agent_legacy_receipts(
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '10000000-0000-0000-0000-000000000000', 'member',
  'x.csv', null, 'Nope', null, '[]'::jsonb, true) $q$, '42501');

-- Authenticated has no grants.
set role authenticated;
select pg_temp.reject($q$ select * from legacy_receipts $q$, '42501');
select pg_temp.reject($q$ select import_legacy_receipts('30000000-0000-0000-0000-000000000001', 'x.csv', 'admin', '[]'::jsonb) $q$, '42501');
reset role;

rollback;
