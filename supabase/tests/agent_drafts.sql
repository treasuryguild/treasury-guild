-- Head schema (migrations 0001-0065): payout transactions, tasks and calls the
-- agent API creates carry their draft id (agent_draft_id), unique per table,
-- and browser roles can never write it. Run with psql -f against an EMPTY
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
-- As on Supabase: new functions are executable by the API roles unless a migration revokes it.
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

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

insert into contributors(wallet_address) values ('alice');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'alice');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'alice', 'owner');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Runs', 'native');

-- 1. Browser roles can never write a draft id -----------------------------------------------
-- tasks: the browser's column grants (0046) leave the column out.
do $$ begin
  if has_column_privilege('authenticated', 'public.tasks', 'agent_draft_id', 'insert')
    or has_column_privilege('authenticated', 'public.tasks', 'agent_draft_id', 'update') then
    raise exception 'the browser may write tasks.agent_draft_id';
  end if;
end $$;
-- transactions and calls: RLS on, and no policy lets a browser role insert or update a row.
do $$
declare
  t text;
begin
  foreach t in array array['transactions', 'calls'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'RLS is off on %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
        and cmd in ('INSERT', 'UPDATE', 'ALL')
        and roles && array['public', 'anon', 'authenticated']::name[]) then
      raise exception 'a browser role may write rows of %', t;
    end if;
  end loop;
end $$;

-- 2. One draft, one row, per table; rows made in the app carry none -------------------------
insert into tasks(workgroup_id, source, title, agent_draft_id) values
  ('20000000-0000-0000-0000-000000000001', 'native', 'From a draft', 'draft-task-0123456789abcdef'),
  ('20000000-0000-0000-0000-000000000001', 'native', 'From the app', null),
  ('20000000-0000-0000-0000-000000000001', 'native', 'Also from the app', null);
select pg_temp.reject($$insert into tasks(workgroup_id, source, title, agent_draft_id)
  values ('20000000-0000-0000-0000-000000000001', 'native', 'Again', 'draft-task-0123456789abcdef')$$, '23505');

insert into transactions(treasury_id, kind, tx_cbor, tx_hash, created_by, state, agent_draft_id) values
  ('40000000-0000-0000-0000-000000000001', 'payout', '00', 'hash-1', 'alice', 2, 'draft-tx-0123456789abcdef'),
  ('40000000-0000-0000-0000-000000000001', 'payout', '00', 'hash-2', 'alice', 2, null),
  ('40000000-0000-0000-0000-000000000001', 'payout', '00', 'hash-3', 'alice', 2, null);
select pg_temp.reject($$insert into transactions(treasury_id, kind, tx_cbor, tx_hash, created_by, state, agent_draft_id)
  values ('40000000-0000-0000-0000-000000000001', 'payout', '00', 'hash-4', 'alice', 2, 'draft-tx-0123456789abcdef')$$, '23505');

insert into calls(community_id, workgroup_id, provider, title, starts_at, ends_at, amounts, created_by, agent_draft_id) values
  ('10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001', 'manual', 'Town hall',
   '2026-10-01 18:00Z', '2026-10-01 19:00Z', '{"ADA":"5"}', 'alice', 'draft-call-0123456789abcdef'),
  ('10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001', 'manual', 'App call',
   '2026-10-02 18:00Z', '2026-10-02 19:00Z', '{"ADA":"5"}', 'alice', null);
select pg_temp.reject($$insert into calls(community_id, workgroup_id, provider, title, starts_at, ends_at, amounts, created_by, agent_draft_id)
  values ('10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001', 'manual', 'Again',
   '2026-10-03 18:00Z', '2026-10-03 19:00Z', '{"ADA":"5"}', 'alice', 'draft-call-0123456789abcdef')$$, '23505');

-- 3. A draft id is the same text in every table without clashing across them ---------------
update tasks set agent_draft_id = 'draft-shared-0123456789abcdef' where title = 'From the app';
update calls set agent_draft_id = 'draft-shared-0123456789abcdef' where title = 'App call';

rollback;
\echo Agent draft tests passed (all changes rolled back).
