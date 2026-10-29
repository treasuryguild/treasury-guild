-- Migration 0078: case-insensitive unique handles with a charset check, and
-- contributors_read only when jwt_wallet() is set. Run with psql -f against
-- an EMPTY disposable PostgreSQL database; everything is rolled back.
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
\ir ../migrations/0074_reconcile_refund_cap.sql
\ir ../migrations/0075_future_budget_month.sql
\ir ../migrations/0076_confirm_pending_on_chain.sql
\ir ../migrations/0077_assignee_github_user_id.sql
\ir ../migrations/0078_p2_hardening.sql

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

insert into contributors(wallet_address, handle) values ('alice', 'Ada'), ('bob', null);

-- Case-blind uniqueness and charset.
select pg_temp.reject($$insert into contributors(wallet_address, handle) values ('eve', 'ada')$$, '23505');
select pg_temp.reject($$update contributors set handle = 'a' where wallet_address = 'bob'$$, '23514');
select pg_temp.reject($$update contributors set handle = 'ada lovelace' where wallet_address = 'bob'$$, '23514');
update contributors set handle = 'bob_42' where wallet_address = 'bob';

-- Anon has no SELECT grant (0046). Authenticated without a wallet claim sees
-- zero rows under the 0078 policy (grant still present; RLS filters).
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.reject($$select * from contributors$$, '42501');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
do $$ begin
  if (select count(*) from contributors) <> 0 then
    raise exception 'authenticated without a wallet claim must see nobody';
  end if;
end $$;
-- With a wallet claim, the roster is readable.
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"alice"}', true);
do $$ begin
  if (select count(*) from contributors) <> 2 then
    raise exception 'signed-in wallet should see every contributor';
  end if;
end $$;
reset role;

-- Service-only tables keep insert/update/delete off the session roles.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"alice"}', true);
select pg_temp.reject($$insert into auth_nonces(nonce, address, expires_at) values ('n', 'alice', now())$$, '42501');
select pg_temp.reject($$insert into rate_limits(key, window_start, hits) values ('x', now(), 1)$$, '42501');
reset role;

rollback;
