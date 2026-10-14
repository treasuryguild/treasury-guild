-- Migration 0060: the electorate hash every ballot signs, the anchored flag,
-- the proposal_anchors link table with its RPC, and transactions.block_time.
-- Run with psql -f against an EMPTY disposable PostgreSQL database; everything
-- is rolled back.
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

insert into contributors(wallet_address) values ('admin'), ('member'), ('outsider');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'Other', 0, 'outsider');
insert into community_members(community_id, wallet_address, role, created_at) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner', now() - interval '9 days'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member', now() - interval '9 days'),
  ('10000000-0000-0000-0000-000000000009', 'outsider', 'owner', now() - interval '9 days');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00'),
  ('40000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000009', 'Theirs', 0, 1, 'addr_theirs', '00');

-- A decision proposal of `community` by `proposer`: voting opens at once (no discussion period).
create function pg_temp.propose(community uuid, proposer text, title text, recuse boolean default false, beneficiaries text[] default '{}')
returns uuid language sql as $$
  select (create_proposal(community, 'decision', title, 'Why', null, '{}',
    repeat('a', 64), format('{"method":"majority","electorate":"members","activityMonths":12,"minMemberDays":0,
      "quorumPct":0,"thresholdPct":50,"lazyObjections":1,"discussionHours":0,"votingHours":72,
      "hideResults":true,"recuseBeneficiaries":%s}', case when recuse then 'true' else 'false' end)::jsonb,
    repeat('b', 64), '{}', beneficiaries, proposer)->>'id')::uuid
$$;

-- Proposals from before the migration: one final, one still voting.
do $$
declare
  old_final uuid := pg_temp.propose('10000000-0000-0000-0000-000000000000', 'member', 'Before, closed');
  old_open uuid := pg_temp.propose('10000000-0000-0000-0000-000000000000', 'member', 'Before, still voting');
begin
  update proposals set closes_at = now() - interval '1 second' where id = old_final;
  perform close_proposal(old_final, 0, 'expired', '{}', 'no_votes');
  perform set_config('test.old_final', old_final::text, false);
  perform set_config('test.old_open', old_open::text, false);
end $$;

\ir ../migrations/0060_anchors.sql

-- 1. The migration: already-final proposals are never anchored, open ones are; no hash before it. ---
do $$ begin
  if (select anchored from proposals where id = current_setting('test.old_final')::uuid) then
    raise exception 'a proposal final before the migration is anchored';
  end if;
  if not (select anchored from proposals where id = current_setting('test.old_open')::uuid) then
    raise exception 'a proposal open at the migration is not anchored';
  end if;
  if (select electorate_hash from proposals where id = current_setting('test.old_open')::uuid) is not null then
    raise exception 'a proposal opened before the migration got a hash';
  end if;
end $$;

-- 2. The electorate hash: the fixed vector src/lib/governance/electorateHash.test.ts pins. ----------
do $$
declare
  pid uuid := pg_temp.propose('10000000-0000-0000-0000-000000000000', 'member', 'Hashed', true, '{admin}');
  expected text := '1207249599776faf8e6edc213696014d65b72a5430a5028e86cac8c4ddea1b57';
begin
  -- Voters: admin (recused as a beneficiary) and member; lines sorted in byte order, no trailing newline.
  if (select string_agg(wallet_address || ' ' || recused::int, ',' order by wallet_address collate "C") from proposal_voters
      where proposal_id = pid) <> 'admin 1,member 0' then
    raise exception 'unexpected electorate';
  end if;
  if (select electorate_hash from proposals where id = pid) <> expected then
    raise exception 'electorate hash % differs from the vector %', (select electorate_hash from proposals where id = pid), expected;
  end if;
  if (select encode(sha256(convert_to(E'admin 1\nmember 0', 'UTF8')), 'hex')) <> expected then
    raise exception 'the vector itself is wrong';
  end if;
  if not (select anchored from proposals where id = pid) then raise exception 'new proposal not anchored'; end if;
  perform set_config('test.hashed', pid::text, false);
end $$;

-- A proposal nobody can vote on is cancelled at once and gets no hash.
do $$
declare
  pid uuid := pg_temp.propose('10000000-0000-0000-0000-000000000009', 'outsider', 'Lonely', true, '{outsider}');
begin
  if (select state from proposals where id = pid) <> 'cancelled' then raise exception 'lonely proposal not cancelled'; end if;
  if (select electorate_hash from proposals where id = pid) is not null then raise exception 'cancelled proposal got a hash'; end if;
end $$;

-- 3. record_proposal_anchors: pending transactions only, the community's anchored proposals only. -----
do $$
declare
  pid uuid := current_setting('test.hashed')::uuid;
  old_final uuid := current_setting('test.old_final')::uuid;
  theirs uuid := pg_temp.propose('10000000-0000-0000-0000-000000000009', 'outsider', 'Theirs');
  tx uuid := '50000000-0000-0000-0000-000000000001';
  n int;
begin
  insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state)
    values (tx, '40000000-0000-0000-0000-000000000001', 'anchor', 'a0', 'admin', 0);
  n := record_proposal_anchors(tx, jsonb_build_array(
    jsonb_build_object('proposalId', pid, 'step', 'proposed'), jsonb_build_object('proposalId', pid, 'step', 'opened')));
  if n <> 2 then raise exception 'expected 2 links, got %', n; end if;
  -- Linking again is idempotent.
  if record_proposal_anchors(tx, jsonb_build_array(jsonb_build_object('proposalId', pid, 'step', 'proposed'))) <> 0 then
    raise exception 'duplicate link counted';
  end if;
  perform pg_temp.reject(format('select record_proposal_anchors(%L, %L)', tx,
    jsonb_build_array(jsonb_build_object('proposalId', theirs, 'step', 'proposed'))), '23514');
  perform pg_temp.reject(format('select record_proposal_anchors(%L, %L)', tx,
    jsonb_build_array(jsonb_build_object('proposalId', old_final, 'step', 'closed'))), '23514');
  perform pg_temp.reject(format('select record_proposal_anchors(%L, %L)', tx,
    jsonb_build_array(jsonb_build_object('proposalId', pid, 'step', 'sealed'))), '23514');
  perform pg_temp.reject(format('select record_proposal_anchors(%L, %L)', tx,
    jsonb_build_array(jsonb_build_object('step', 'proposed'))), '23514');
  perform pg_temp.reject(format('select record_proposal_anchors(%L, %L)', tx, '{"proposalId": "x"}'), '23514');
  perform pg_temp.reject(format('select record_proposal_anchors(%L, %L)', gen_random_uuid(), '[]'), 'P0002');
  -- Once submitted, no more links.
  update transactions set state = 1 where id = tx;
  perform pg_temp.reject(format('select record_proposal_anchors(%L, %L)', tx,
    jsonb_build_array(jsonb_build_object('proposalId', pid, 'step', 'closed'))), '23514');
  if (select count(*) from proposal_anchors where transaction_id = tx) <> 2 then raise exception 'links lost'; end if;
  -- block_time is the poller's to set; a deleted transaction takes its links with it.
  update transactions set state = 2, block_time = now() where id = tx;
  insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state)
    values ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'payout', 'c0', 'admin', 0);
  perform record_proposal_anchors('50000000-0000-0000-0000-000000000002', jsonb_build_array(jsonb_build_object('proposalId', pid, 'step', 'closed')));
  delete from transactions where id = '50000000-0000-0000-0000-000000000002';
  if (select count(*) from proposal_anchors where proposal_id = pid) <> 2 then raise exception 'links did not cascade'; end if;
end $$;

-- 4. Members read the anchors with their transactions; a stranger sees none; nobody writes. -------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
do $$ begin
  if (select count(*) from proposal_anchors a join transactions t on t.id = a.transaction_id where t.state = 2 and t.block_time is not null) <> 2 then
    raise exception 'member cannot read the anchors with their transactions';
  end if;
  if (select electorate_hash from proposals where id = current_setting('test.hashed')::uuid) is null then
    raise exception 'member cannot read the electorate hash';
  end if;
end $$;
select pg_temp.reject($q$ insert into proposal_anchors(proposal_id, step, transaction_id)
  values (current_setting('test.hashed')::uuid, 'closed', '50000000-0000-0000-0000-000000000001') $q$, '42501');
select pg_temp.reject($q$ delete from proposal_anchors $q$, '42501');
select pg_temp.reject(format('select record_proposal_anchors(%L, %L)', '50000000-0000-0000-0000-000000000001', '[]'), '42501');
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"outsider"}', true);
do $$ begin
  if (select count(*) from proposal_anchors) <> 0 then raise exception 'outsider reads another community''s anchors'; end if;
end $$;
reset role;

rollback;
\echo Anchor tests passed.
