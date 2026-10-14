-- Migration 0059: one pending transaction per treasury, frozen tally
-- documents and their copies, the community-level governance settings, the
-- proposal back-links on tasks and budgets, and the outside-spend alert stamp.
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
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Second', 0, 1, 'addr_second', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Dev', 'native');
insert into board_columns(id, workgroup_id, name, position, marks_payable, marks_paid) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Backlog', 0, false, false);
-- A spend from before the migration: history, never announced.
insert into external_txs(tx_hash, treasury_id, block_height, block_time, fee_lovelace, amount_lovelace, to_addresses)
  values ('before', '40000000-0000-0000-0000-000000000001', 1, '2026-08-10T12:00:00Z', 200000, 1000000, '{bob}');

\ir ../migrations/0059_anchoring_groundwork.sql

-- A proposal that reached voting and closed as `outcome` (made, one ballot, deadline passed).
create function pg_temp.voted(kind text, title text, payload jsonb, outcome text default 'passed') returns uuid
language plpgsql as $$
declare pid uuid;
begin
  pid := (create_proposal('10000000-0000-0000-0000-000000000000', kind, title, 'Why', null, payload,
    repeat('a', 64), '{"method":"majority","electorate":"members","activityMonths":12,"minMemberDays":0,
      "quorumPct":0,"thresholdPct":50,"lazyObjections":1,"discussionHours":0,"votingHours":72,
      "hideResults":true,"recuseBeneficiaries":false}', repeat('b', 64), '{}', '{}', 'member')->>'id')::uuid;
  perform cast_proposal_vote(pid, 'admin', case when outcome = 'passed' then 'yes' else 'no' end, null,
    clock_timestamp(), 'ballot', 'a1', 'b2');
  update proposals set closes_at = now() - interval '1 second' where id = pid;
  perform close_proposal(pid, 1, outcome, '{}', outcome);
  return pid;
end $$;
-- A proposal still in discussion (a day of it).
create function pg_temp.discussed(title text) returns uuid language sql as $$
  select (create_proposal('10000000-0000-0000-0000-000000000000', 'decision', title, 'Why', null, '{}',
    repeat('a', 64), '{"method":"majority","electorate":"members","activityMonths":12,"minMemberDays":0,
      "quorumPct":0,"thresholdPct":50,"lazyObjections":1,"discussionHours":24,"votingHours":72,
      "hideResults":true,"recuseBeneficiaries":false}', repeat('b', 64), '{}', '{}', 'member')->>'id')::uuid
$$;

-- 1. One pending transaction per treasury, whatever the kind. --------------------
do $$ begin
  insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state) values
    ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'payout', 'c0', 'admin', 0),
    ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'anchor', 'a0', 'admin', 0);
  perform pg_temp.reject($q$ insert into transactions(treasury_id, kind, tx_cbor, created_by, state)
    values ('40000000-0000-0000-0000-000000000001', 'anchor', 'a1', 'admin', 0) $q$, '23505');
  perform pg_temp.reject($q$ insert into transactions(treasury_id, kind, tx_cbor, created_by, state)
    values ('40000000-0000-0000-0000-000000000001', 'payment', 'p1', 'admin', 0) $q$, '23505');
  -- Submitted, confirmed and rejected rows never block; a new pending one may follow them.
  update transactions set state = 1 where id = '50000000-0000-0000-0000-000000000001';
  insert into transactions(treasury_id, kind, tx_cbor, created_by, state) values
    ('40000000-0000-0000-0000-000000000001', 'payout', 'c2', 'admin', 2),
    ('40000000-0000-0000-0000-000000000001', 'payout', 'c3', 'admin', 3),
    ('40000000-0000-0000-0000-000000000001', 'payment', 'p2', 'admin', 0);
  if (select spend_problems from transactions where tx_cbor = 'p2') <> '[]'::jsonb then
    raise exception 'spend_problems does not default to []';
  end if;
  perform pg_temp.reject($q$ insert into transactions(treasury_id, kind, tx_cbor, created_by, state)
    values ('40000000-0000-0000-0000-000000000001', 'proposal', 'x', 'admin', 0) $q$, '23514');
end $$;

-- 2. The frozen tally document: once, for a final proposal that reached voting. ------
do $$
declare
  passed uuid := pg_temp.voted('decision', 'Adopt the plan', '{}');
  open_one uuid := pg_temp.discussed('Still open');
  withdrawn uuid := pg_temp.discussed('Never voted');
begin
  perform end_proposal(withdrawn, 'member', 'withdrawn', null);
  perform pg_temp.reject(format('select freeze_proposal_tally(%L, %L, %L)', open_one, '{}', repeat('c', 64)), '23514');
  perform pg_temp.reject(format('select freeze_proposal_tally(%L, %L, %L)', withdrawn, '{}', repeat('c', 64)), '23514');
  perform pg_temp.reject(format('select freeze_proposal_tally(%L, %L, %L)', gen_random_uuid(), '{}', repeat('c', 64)), 'P0002');
  if not freeze_proposal_tally(passed, '{"body":1}', repeat('c', 64)) then raise exception 'first freeze refused'; end if;
  -- Write once: a second call changes nothing and says so.
  if freeze_proposal_tally(passed, '{"body":2}', repeat('d', 64)) then raise exception 'second freeze accepted'; end if;
  if (select document || '|' || hash from proposal_tally_documents where proposal_id = passed) <> '{"body":1}|' || repeat('c', 64) then
    raise exception 'document changed on the second freeze';
  end if;
  perform pg_temp.reject(format($q$ insert into proposal_tally_documents(proposal_id, community_id, document, hash)
    values (%L, '10000000-0000-0000-0000-000000000000', 'x', 'nothex') $q$, open_one), '23514');
  -- Copies: one per store, a known store only.
  insert into proposal_document_copies(proposal_id, community_id, store, locator)
    values (passed, '10000000-0000-0000-0000-000000000000', 'ipfs', 'bafy1');
  perform pg_temp.reject(format($q$ insert into proposal_document_copies(proposal_id, community_id, store, locator)
    values (%L, '10000000-0000-0000-0000-000000000000', 'ipfs', 'bafy2') $q$, passed), '23505');
  perform pg_temp.reject(format($q$ insert into proposal_document_copies(proposal_id, community_id, store, locator)
    values (%L, '10000000-0000-0000-0000-000000000000', 'arweave', 'ar1') $q$, passed), '23514');
  perform pg_temp.reject(format($q$ insert into proposal_document_copies(proposal_id, community_id, store, locator)
    values (%L, '10000000-0000-0000-0000-000000000000', 'ipfs', 'bafy3') $q$, open_one), '23503');
end $$;

-- Members read the document and its copies; a stranger sees nothing; nobody writes.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
do $$ begin
  if (select count(*) from proposal_tally_documents) <> 1 or (select count(*) from proposal_document_copies) <> 1 then
    raise exception 'member cannot read the frozen record';
  end if;
end $$;
select pg_temp.reject($q$ update proposal_tally_documents set document = 'tampered' $q$, '42501');
select pg_temp.reject($q$ delete from proposal_document_copies $q$, '42501');
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"outsider"}', true);
do $$ begin
  if (select count(*) from proposal_tally_documents) <> 0 or (select count(*) from proposal_document_copies) <> 0 then
    raise exception 'outsider reads another community''s record';
  end if;
end $$;
reset role;

-- 3. Community-level settings, logged with the per-kind changes. ----------------------
do $$
declare
  c uuid := '10000000-0000-0000-0000-000000000000';
  since timestamptz;
begin
  perform save_governance_community_settings(c, '{"document_store": null, "spend_check": "refuse"}', 'admin');
  if (select document_store is null and document_store_since is null and spend_check = 'refuse' from governance_community_settings
      where community_id = c) is not true then raise exception 'first save wrong'; end if;
  perform save_governance_community_settings(c, '{"document_store": "ipfs", "spend_check": "warn"}', 'admin');
  select document_store_since into since from governance_community_settings where community_id = c;
  if since is null then raise exception 'turning the store on did not stamp since'; end if;
  -- Saving again with the same store keeps the stamp; switching off clears it.
  perform save_governance_community_settings(c, '{"document_store": "ipfs", "spend_check": "refuse"}', 'admin');
  if (select document_store_since from governance_community_settings where community_id = c) <> since then
    raise exception 'since moved without a store change';
  end if;
  perform save_governance_community_settings(c, '{"spend_check": "warn"}', 'admin');
  if (select document_store is null and document_store_since is null and spend_check = 'warn' from governance_community_settings
      where community_id = c) is not true then raise exception 'turning the store off wrong'; end if;
  perform pg_temp.reject(format('select save_governance_community_settings(%L, %L, %L)', c, '{"document_store": "arweave"}', 'admin'), '23514');
  perform pg_temp.reject(format('select save_governance_community_settings(%L, %L, %L)', c, '{"spend_check": "ignore"}', 'admin'), '23514');
  if (select count(*) from governance_setting_changes where community_id = c and kind = 'community') <> 4 then
    raise exception 'community setting changes not logged';
  end if;
  -- (changed_at is now(), the same for every row of this transaction: each entry is found by what it says.)
  if not exists (select 1 from governance_setting_changes where community_id = c and kind = 'community'
      and before_value is null and after_value->>'spend_check' = 'refuse' and after_value->>'document_store' is null) then
    raise exception 'first change logged wrongly';
  end if;
  if not exists (select 1 from governance_setting_changes where community_id = c and kind = 'community'
      and before_value->>'document_store' = 'ipfs' and after_value->>'document_store' is null
      and after_value->>'spend_check' = 'warn') then
    raise exception 'last change logged wrongly';
  end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
do $$ begin
  if (select count(*) from governance_community_settings) <> 1 then raise exception 'member cannot read the community settings'; end if;
end $$;
select pg_temp.reject($q$ update governance_community_settings set spend_check = 'refuse' $q$, '42501');
reset role;

-- 4. Budget rows remember the proposal that set them; tasks their proposal. ------------
do $$
declare
  dev uuid := '20000000-0000-0000-0000-000000000001';
  applying uuid := gen_random_uuid();
  sid uuid;
begin
  -- A direct save: no proposal.
  perform save_budget_setup(dev, 0, 'monthly', 'monthly', date_trunc('month', now() at time zone 'UTC')::date,
    '[{"unit":"lovelace","amount":"100000000","asset_label":"ADA","decimals":6}]', 'admin');
  select id into sid from budget_setups where workgroup_id = dev;
  if (select proposal_id from budget_setups where id = sid) is not null
      or (select proposal_id from budget_plans where setup_id = sid) is not null then
    raise exception 'direct save stamped a proposal';
  end if;
  -- A proposal apply: the id in treasury_guild.proposal_apply (a real proposal, for the foreign key).
  applying := pg_temp.discussed('Budget by vote');
  perform set_config('treasury_guild.proposal_apply', applying::text, true);
  perform save_budget_setup(dev, 1, 'monthly', 'monthly', (date_trunc('month', now() at time zone 'UTC') + interval '1 month')::date,
    '[{"unit":"lovelace","amount":"200000000","asset_label":"ADA","decimals":6}]', 'admin');
  if (select proposal_id from budget_plans where setup_id = sid
      and starts_on = (date_trunc('month', now() at time zone 'UTC') + interval '1 month')::date) <> applying then
    raise exception 'plan row not stamped with the applying proposal';
  end if;
  -- The dry run's marker is not an id: null, never an error.
  perform set_config('treasury_guild.proposal_apply', 'check', true);
  perform save_budget_setup(dev, 2, 'monthly', 'monthly', (date_trunc('month', now() at time zone 'UTC') + interval '2 month')::date,
    '[{"unit":"lovelace","amount":"300000000","asset_label":"ADA","decimals":6}]', 'admin');
  if (select proposal_id from budget_plans where setup_id = sid
      and starts_on = (date_trunc('month', now() at time zone 'UTC') + interval '2 month')::date) is not null then
    raise exception 'the dry-run marker was stamped';
  end if;
  perform set_config('treasury_guild.proposal_apply', '', true);
  -- The month the vote set, saved again directly: now a direct value.
  perform save_budget_setup(dev, 3, 'monthly', 'monthly', (date_trunc('month', now() at time zone 'UTC') + interval '1 month')::date,
    '[{"unit":"lovelace","amount":"250000000","asset_label":"ADA","decimals":6}]', 'admin');
  if (select proposal_id from budget_plans where setup_id = sid
      and starts_on = (date_trunc('month', now() at time zone 'UTC') + interval '1 month')::date) is not null then
    raise exception 'a direct update kept the old proposal';
  end if;
end $$;

do $$
declare
  pid uuid;
  tid uuid;
begin
  pid := pg_temp.voted('task', 'Write the guide', jsonb_build_object('task', jsonb_build_object(
    'workgroupId', '20000000-0000-0000-0000-000000000001', 'amounts', '{"ADA":"10"}'::jsonb, 'bountyLovelace', '10000000')));
  if execute_proposal(pid) <> 'applied' then raise exception 'task not created: %', (select execution_error from proposals where id = pid); end if;
  tid := (select (execution_result->>'taskId')::uuid from proposals where id = pid);
  if (select proposal_id from tasks where id = tid) <> pid then raise exception 'task not linked to its proposal'; end if;
end $$;

-- The re-created apply_task_proposal still refuses a board that changed since the vote.
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Ops', 'native'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000', 'Gone', 'native');
do $$
declare
  task jsonb := jsonb_build_object('amounts', '{"ADA":"10"}'::jsonb, 'bountyLovelace', '10000000');
  on_ops uuid := pg_temp.voted('task', 'On Ops', jsonb_build_object('task', task || '{"workgroupId":"20000000-0000-0000-0000-000000000002"}'::jsonb));
  on_dev uuid := pg_temp.voted('task', 'On Dev', jsonb_build_object('task', task || '{"workgroupId":"20000000-0000-0000-0000-000000000001"}'::jsonb));
  on_gone uuid := pg_temp.voted('task', 'On Gone', jsonb_build_object('task', task || '{"workgroupId":"20000000-0000-0000-0000-000000000003"}'::jsonb));
  tasks_before bigint := (select count(*) from tasks);
begin
  update workgroups set kind = 'github' where id = '20000000-0000-0000-0000-000000000002';
  update workgroups set archived_at = now() where id = '20000000-0000-0000-0000-000000000001';
  delete from workgroups where id = '20000000-0000-0000-0000-000000000003';
  if execute_proposal(on_ops) <> 'failed'
      or (select execution_error from proposals where id = on_ops) <> 'Tasks are proposed only on app boards, and Ops is a GitHub board' then
    raise exception 'GitHub board: %', (select execution_error from proposals where id = on_ops);
  end if;
  if execute_proposal(on_dev) <> 'failed'
      or (select execution_error from proposals where id = on_dev) <> 'Restore the workgroup Dev before adding the task' then
    raise exception 'archived board: %', (select execution_error from proposals where id = on_dev);
  end if;
  if execute_proposal(on_gone) <> 'failed'
      or (select execution_error from proposals where id = on_gone) <> 'The workgroup of this task no longer exists' then
    raise exception 'deleted board: %', (select execution_error from proposals where id = on_gone);
  end if;
  if (select count(*) from tasks) <> tasks_before then raise exception 'a refused task proposal created a task'; end if;
  update workgroups set archived_at = null where id = '20000000-0000-0000-0000-000000000001';
end $$;
-- The browser reads the link but never writes it.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
do $$ begin
  if (select count(*) from tasks where proposal_id is not null) <> 1 then raise exception 'member cannot read the task link'; end if;
end $$;
select pg_temp.reject($q$ update tasks set proposal_id = null $q$, '42501');
select pg_temp.reject($q$ insert into tasks(workgroup_id, title, column_id, proposal_id)
  values ('20000000-0000-0000-0000-000000000001', 'Sneaky', '30000000-0000-0000-0000-000000000001', null) $q$, '42501');
reset role;

-- 5. Outside-spend alerts: history is stamped by the migration, new rows are not. -------
do $$ begin
  if (select governance_alerted_at from external_txs where tx_hash = 'before') is null then
    raise exception 'pre-migration spend left unstamped';
  end if;
  insert into external_txs(tx_hash, treasury_id, block_height, block_time, fee_lovelace, amount_lovelace, to_addresses)
    values ('after', '40000000-0000-0000-0000-000000000001', 2, now(), 200000, 1000000, '{bob}');
  if (select governance_alerted_at from external_txs where tx_hash = 'after') is not null then
    raise exception 'new spend stamped';
  end if;
end $$;

rollback;
\echo Anchoring groundwork tests passed.
