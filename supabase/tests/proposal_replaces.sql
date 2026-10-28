-- Migration 0068: a proposal may replace one still in discussion. The
-- replacement withdraws the old one and hands off budget locks in the same
-- transaction. Run with psql -f against an EMPTY disposable PostgreSQL
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

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

create function pg_temp.rules(hours int default 48) returns jsonb language sql as $$
  select jsonb_build_object(
    'method', 'majority', 'electorate', 'members', 'activityMonths', 12, 'minMemberDays', 0,
    'quorumPct', 20, 'thresholdPct', 50, 'lazyObjections', 1, 'discussionHours', hours,
    'votingHours', 72, 'hideResults', true, 'recuseBeneficiaries', false)
$$;

-- A decision still in discussion (48h before voting).
create function pg_temp.propose_discussion(title text, proposer text default 'alice',
    kind text default 'decision', owners jsonb default '[]', workgroups uuid[] default '{}')
returns uuid language sql as $$
  select (create_proposal('10000000-0000-0000-0000-000000000000', kind, title, 'Why', null, '{}',
    repeat('a', 64), pg_temp.rules(48), repeat('b', 64), workgroups, '{}', proposer, owners)->>'id')::uuid
$$;

insert into contributors(wallet_address) values ('alice'), ('bob'), ('mallory');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'alice'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'Other', 0, 'mallory');
insert into community_members(community_id, wallet_address, role, created_at) values
  ('10000000-0000-0000-0000-000000000000', 'alice', 'owner', now() - interval '90 days'),
  ('10000000-0000-0000-0000-000000000000', 'bob', 'member', now() - interval '90 days'),
  ('10000000-0000-0000-0000-000000000009', 'mallory', 'owner', now() - interval '90 days');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Dev', 'native');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 1. Happy path: same proposer revises a discussion proposal ---------------------------
do $$
declare
  old_id uuid := pg_temp.propose_discussion('First draft');
  old_number int;
  created jsonb;
  new_id uuid;
begin
  select number into old_number from proposals where id = old_id;
  if (select state from proposals where id = old_id) <> 'discussion' then
    raise exception 'seed proposal not in discussion';
  end if;
  created := create_proposal('10000000-0000-0000-0000-000000000000', 'decision', 'Revised draft', 'Why not',
    null, '{}', repeat('c', 64), pg_temp.rules(48), repeat('d', 64), '{}', '{}', 'alice', '[]', old_id);
  new_id := (created->>'id')::uuid;
  if (select state from proposals where id = old_id) <> 'withdrawn'
      or (select end_reason from proposals where id = old_id) <> ('Revised as #' || (created->>'number')) then
    raise exception 'old proposal was not withdrawn as a revision: %', (select row_to_json(p) from proposals p where id = old_id);
  end if;
  if (select replaces_proposal_id from proposals where id = new_id) is distinct from old_id then
    raise exception 'replacement did not point at the old proposal';
  end if;
  if (select state from proposals where id = new_id) <> 'discussion' then
    raise exception 'replacement left discussion: %', (select state from proposals where id = new_id);
  end if;
  if not exists (
    select 1 from proposal_events where proposal_id = old_id and action = 'withdrawn'
      and detail->>'revisedAs' = created->>'number'
  ) then
    raise exception 'withdrawn event missing revisedAs';
  end if;
  if not exists (
    select 1 from proposal_events where proposal_id = new_id and action = 'created'
      and (detail->>'replaces')::int = old_number
  ) then
    raise exception 'created event missing replaces number';
  end if;
end $$;

-- 2. Guards: other proposer, past discussion, kind mismatch, other community ----------
do $$
declare
  in_discussion uuid := pg_temp.propose_discussion('Still open');
  voting uuid;
  other uuid;
begin
  -- Other proposer.
  perform pg_temp.reject(format($q$select create_proposal('10000000-0000-0000-0000-000000000000', 'decision',
    'Nope', 'Why', null, '{}', repeat('a', 64), %L, repeat('b', 64), '{}', '{}', 'bob', '[]', %L)$q$,
    pg_temp.rules(48), in_discussion), '42501');

  -- Kind mismatch.
  perform pg_temp.reject(format($q$select create_proposal('10000000-0000-0000-0000-000000000000', 'task',
    'Nope', 'Why', null, '{}', repeat('a', 64), %L, repeat('b', 64), '{}', '{}', 'alice', '[]', %L)$q$,
    pg_temp.rules(48), in_discussion), '23514');

  -- Past discussion (voting already open).
  voting := (create_proposal('10000000-0000-0000-0000-000000000000', 'decision', 'Open now', 'Why', null, '{}',
    repeat('a', 64), pg_temp.rules(0), repeat('b', 64), '{}', '{}', 'alice', '[]')->>'id')::uuid;
  if (select state from proposals where id = voting) <> 'voting' then
    raise exception 'zero-discussion proposal did not open voting';
  end if;
  perform pg_temp.reject(format($q$select create_proposal('10000000-0000-0000-0000-000000000000', 'decision',
    'Too late', 'Why', null, '{}', repeat('a', 64), %L, repeat('b', 64), '{}', '{}', 'alice', '[]', %L)$q$,
    pg_temp.rules(48), voting), '23514');

  -- Other community's proposal.
  other := (create_proposal('10000000-0000-0000-0000-000000000009', 'decision', 'Elsewhere', 'Why', null, '{}',
    repeat('a', 64), pg_temp.rules(48), repeat('b', 64), '{}', '{}', 'mallory', '[]')->>'id')::uuid;
  perform pg_temp.reject(format($q$select create_proposal('10000000-0000-0000-0000-000000000000', 'decision',
    'Cross', 'Why', null, '{}', repeat('a', 64), %L, repeat('b', 64), '{}', '{}', 'alice', '[]', %L)$q$,
    pg_temp.rules(48), other), '23514');
end $$;

-- 3. Budget lock handoff: old owners deactivate, new ones take the lock ---------------
do $$
declare
  wg uuid := '20000000-0000-0000-0000-000000000001';
  owners jsonb := jsonb_build_array(jsonb_build_object('workgroupId', wg, 'treasuryId', null, 'baseRevision', 0));
  old_id uuid;
  created jsonb;
  new_id uuid;
begin
  old_id := pg_temp.propose_discussion('Budget v1', 'alice', 'budget', owners, array[wg]);
  if (select count(*) from proposal_budget_owners where proposal_id = old_id and active) <> 1 then
    raise exception 'old budget proposal did not lock the owner';
  end if;
  created := create_proposal('10000000-0000-0000-0000-000000000000', 'budget', 'Budget v2', 'Why',
    null, '{}', repeat('e', 64), pg_temp.rules(48), repeat('f', 64), array[wg], '{}', 'alice', owners, old_id);
  new_id := (created->>'id')::uuid;
  if exists (select 1 from proposal_budget_owners where proposal_id = old_id and active) then
    raise exception 'old budget locks stayed active after revision';
  end if;
  if (select count(*) from proposal_budget_owners where proposal_id = new_id and active) <> 1 then
    raise exception 'replacement did not lock the owner';
  end if;
  if (select state from proposals where id = old_id) <> 'withdrawn' then
    raise exception 'budget proposal was not withdrawn on revise';
  end if;
end $$;

reset role;
rollback;
\echo Proposal replaces tests passed.
