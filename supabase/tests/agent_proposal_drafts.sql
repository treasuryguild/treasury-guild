-- Head schema (migrations 0001-0064): proposals made through the agent API are
-- keyed by their draft (create_proposal_from_draft), so one draft confirmed
-- twice makes one proposal. Run with psql -f against an EMPTY disposable
-- PostgreSQL database; everything is rolled back.
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

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

create function pg_temp.draft(draft_id text, proposer text default 'alice', title text default 'Adopt the handbook')
returns jsonb language sql as $$
  select create_proposal_from_draft(draft_id, '10000000-0000-0000-0000-000000000000', 'decision', title, 'Why',
    null, '{}', repeat('a', 64),
    '{"method":"majority","electorate":"members","activityMonths":12,"minMemberDays":0,"quorumPct":20,
      "thresholdPct":50,"lazyObjections":1,"discussionHours":48,"votingHours":72,"hideResults":true,
      "recuseBeneficiaries":false}'::jsonb,
    repeat('b', 64), '{}', '{}', proposer, '[]')
$$;

insert into contributors(wallet_address) values ('alice'), ('bob'), ('mallory');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'alice');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'alice', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'bob', 'member');

-- 1. Only the service role may call it -------------------------------------------------------
do $$
declare
  f text := 'public.create_proposal_from_draft(text, uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb)';
begin
  if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
    raise exception 'a browser role may execute %', f;
  end if;
  if not has_function_privilege('service_role', f, 'execute') then raise exception 'service_role may not execute %', f; end if;
end $$;

-- 2. One draft makes one proposal, however often it is confirmed ------------------------------
do $$
declare
  first jsonb := pg_temp.draft('draft-0001-aaaaaaaaaaaaaaaa');
  again jsonb := pg_temp.draft('draft-0001-aaaaaaaaaaaaaaaa');
begin
  if (first->>'created')::boolean is not true then raise exception 'the first confirmation created nothing: %', first; end if;
  if (again->>'created')::boolean is not false then raise exception 'the replay created again: %', again; end if;
  if again->>'id' <> first->>'id' or again->>'number' <> first->>'number' then
    raise exception 'the replay answered another proposal: % vs %', again, first;
  end if;
  if (select count(*) from proposals where agent_draft_id = 'draft-0001-aaaaaaaaaaaaaaaa') <> 1 then
    raise exception 'one draft made more than one proposal';
  end if;
  if (select count(*) from proposal_events where proposal_id = (first->>'id')::uuid and action = 'created') <> 1 then
    raise exception 'the replay logged a second creation';
  end if;
end $$;

-- 3. Another draft, even with the same content, is another proposal ---------------------------
do $$
declare
  first int := (select number from proposals where agent_draft_id = 'draft-0001-aaaaaaaaaaaaaaaa');
  second jsonb := pg_temp.draft('draft-0002-bbbbbbbbbbbbbbbb');
begin
  if (second->>'created')::boolean is not true or (second->>'number')::int <> first + 1 then
    raise exception 'a second draft did not get the next number: %', second;
  end if;
end $$;

-- 4. App proposals carry no draft; a draft id is never reused by another proposer -------------
do $$ begin
  perform create_proposal('10000000-0000-0000-0000-000000000000', 'decision', 'From the app', 'Why', null, '{}',
    repeat('a', 64), '{"discussionHours":48,"votingHours":72}'::jsonb, repeat('b', 64), '{}', '{}', 'bob', '[]');
  if (select agent_draft_id from proposals where title = 'From the app') is not null then
    raise exception 'an app proposal got a draft id';
  end if;
end $$;
select pg_temp.reject($$select pg_temp.draft('draft-0001-aaaaaaaaaaaaaaaa', 'bob')$$, '42501');
select pg_temp.reject($$update proposals set agent_draft_id = 'draft-0002-bbbbbbbbbbbbbbbb' where title = 'From the app'$$, '23505');

-- 5. The checks of create_proposal still apply; a bad draft id is refused ---------------------
select pg_temp.reject($$select pg_temp.draft('draft-0003-cccccccccccccccc', 'mallory')$$, '42501');
do $$ begin
  if exists (select 1 from proposals where agent_draft_id = 'draft-0003-cccccccccccccccc') then
    raise exception 'a refused draft left a proposal behind';
  end if;
end $$;
select pg_temp.reject($$select pg_temp.draft('short')$$, '22023');
select pg_temp.reject($$select pg_temp.draft(null)$$, '22023');

rollback;
\echo Agent proposal draft tests passed (all changes rolled back).
