-- Migration 0073: community invite links are service-role only; redeem joins
-- as a member, is idempotent for an existing member, and refuses exhausted /
-- revoked / expired tokens with the same no_data_found. Run with psql -f
-- against an EMPTY disposable PostgreSQL database; everything is rolled back.
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

-- Sessions and the anon key cannot read invites or redeem.
set local role authenticated;
select pg_temp.reject($$select * from community_invites$$, '42501');
select pg_temp.reject($$select redeem_community_invite('x', 'w')$$, '42501');
select pg_temp.reject($$select purge_community_invites(now())$$, '42501');
reset role;
set local role anon;
select pg_temp.reject($$select * from community_invites$$, '42501');
select pg_temp.reject($$select redeem_community_invite('x', 'w')$$, '42501');
reset role;

set local role service_role;

insert into contributors(wallet_address) values ('addr_owner'), ('addr_alice');
insert into communities(id, slug, name, network, created_by)
values ('10000000-0000-4000-8000-000000000001', 'demo', 'Demo', 0, 'addr_owner');
insert into community_members(community_id, wallet_address, role)
values ('10000000-0000-4000-8000-000000000001', 'addr_owner', 'owner');

insert into community_invites(id, community_id, token_hash, created_by, max_uses)
values (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'hash-one',
  'addr_owner',
  1
);

-- First redeem joins as member and burns the single use.
do $$ declare r jsonb; begin
  r := redeem_community_invite('hash-one', 'addr_alice');
  if r->>'slug' <> 'demo' or r->>'name' <> 'Demo'
     or (r->>'network')::int <> 0 or (r->>'already')::boolean
     or r->>'communityId' <> '10000000-0000-4000-8000-000000000001' then
    raise exception 'Unexpected redeem result: %', r;
  end if;
  if (select role from community_members
      where community_id = '10000000-0000-4000-8000-000000000001'
        and wallet_address = 'addr_alice') <> 'member' then
    raise exception 'Alice was not added as a member';
  end if;
  if (select use_count from community_invites
      where id = '20000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'Use count not incremented';
  end if;
end $$;

-- Same wallet again: already, no second use burned.
do $$ declare r jsonb; begin
  r := redeem_community_invite('hash-one', 'addr_alice');
  if not (r->>'already')::boolean then
    raise exception 'Re-redeem should report already';
  end if;
  if (select use_count from community_invites
      where id = '20000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'Re-redeem burned another use';
  end if;
end $$;

-- Exhausted for a new wallet.
select pg_temp.reject(
  $$select redeem_community_invite('hash-one', 'addr_bob')$$,
  'P0002'
);

-- Unknown / revoked / expired tokens also raise no_data_found.
select pg_temp.reject(
  $$select redeem_community_invite('missing', 'addr_alice')$$,
  'P0002'
);

insert into community_invites(id, community_id, token_hash, created_by, revoked_at)
values (
  '20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'hash-revoked',
  'addr_owner',
  now()
);
select pg_temp.reject(
  $$select redeem_community_invite('hash-revoked', 'addr_alice')$$,
  'P0002'
);

insert into community_invites(id, community_id, token_hash, created_by, expires_at)
values (
  '20000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000001',
  'hash-expired',
  'addr_owner',
  now() - interval '1 hour'
);
select pg_temp.reject(
  $$select redeem_community_invite('hash-expired', 'addr_alice')$$,
  'P0002'
);

-- Purge drops only old expired / revoked rows.
do $$ declare removed integer; begin
  removed := purge_community_invites(now());
  if removed <> 0 then raise exception 'Fresh expired/revoked rows purged early'; end if;
  update community_invites
  set expires_at = now() - interval '100 days'
  where token_hash = 'hash-expired';
  update community_invites
  set revoked_at = now() - interval '100 days'
  where token_hash = 'hash-revoked';
  removed := purge_community_invites(now());
  if removed <> 2 then raise exception 'expected 2 rows purged, got %', removed; end if;
  if (select count(*) from community_invites) <> 1 then
    raise exception 'Active invite was purged';
  end if;
end $$;

reset role;
rollback;
