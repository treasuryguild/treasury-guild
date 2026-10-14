-- Migration 0055: proposals, voting and budget consent.
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

create function pg_temp.ada(value text) returns jsonb language sql as
  $$ select jsonb_build_array(jsonb_build_object('unit', 'lovelace', 'amount', value, 'asset_label', 'ADA', 'decimals', 6)) $$;
-- Proposal rules as the app freezes them; `patch` overrides some.
create function pg_temp.rules(patch jsonb default '{}') returns jsonb language sql as $$
  select '{"method":"majority","electorate":"members","activityMonths":12,"minMemberDays":0,"quorumPct":20,
    "thresholdPct":50,"lazyObjections":1,"discussionHours":0,"votingHours":72,"hideResults":true,
    "recuseBeneficiaries":false}'::jsonb || patch
$$;
create function pg_temp.propose(kind text, rules jsonb, proposer text default 'member',
    workgroups uuid[] default '{}', beneficiaries text[] default '{}', payload jsonb default '{}',
    owners jsonb default '[]') returns uuid language sql as $$
  select (create_proposal('10000000-0000-0000-0000-000000000000', kind, 'A proposal', 'Why', null, payload,
    repeat('a', 64), rules, repeat('b', 64), workgroups, beneficiaries, proposer, owners)->>'id')::uuid
$$;
create function pg_temp.vote(pid uuid, voter text, choice text, reason text default null,
    at timestamptz default clock_timestamp()) returns int language sql as $$
  select cast_proposal_vote(pid, voter, choice, reason, at, 'ballot', 'a1', 'b2')
$$;
-- Deadlines are in the past from here on (now() is fixed inside a transaction).
create function pg_temp.expire(pid uuid) returns void language sql as $$
  update proposals set closes_at = now() - interval '1 second' where id = pid
$$;

insert into contributors(wallet_address) values
  ('admin'), ('lead'), ('member'), ('paid'), ('newbie'), ('outsider');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'Other', 0, 'outsider');
insert into community_members(community_id, wallet_address, role, created_at) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner', now() - interval '90 days'),
  ('10000000-0000-0000-0000-000000000000', 'lead', 'member', now() - interval '90 days'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member', now() - interval '90 days'),
  ('10000000-0000-0000-0000-000000000000', 'paid', 'member', now() - interval '5 days'),
  -- Joins after the proposals below are made: never in their electorates.
  ('10000000-0000-0000-0000-000000000000', 'newbie', 'member', now() + interval '1 minute'),
  ('10000000-0000-0000-0000-000000000009', 'outsider', 'owner', now() - interval '90 days');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Dev', 'native'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Docs', 'native'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000', 'Ops', 'native');
insert into workgroup_leads(workgroup_id, wallet_address) values ('20000000-0000-0000-0000-000000000001', 'lead');
insert into tasks(id, workgroup_id, title, source) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Paid work', 'native'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Docs work', 'native');
insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state, submitted_at) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'payout', '00', 'admin', 2, now() - interval '40 days'),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'payout', '00', 'admin', 3, now() - interval '1 month');
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount) values
  ('50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'paid', 'lovelace', 100),
  -- A rejected transaction pays nobody.
  ('50000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'member', 'lovelace', 100);

-- 1. Who votes.
do $$
declare
  c uuid := '10000000-0000-0000-0000-000000000000';
  dev uuid[] := array['20000000-0000-0000-0000-000000000001'::uuid];
  docs uuid[] := array['20000000-0000-0000-0000-000000000002'::uuid];
  got text;
begin
  select string_agg(wallet_address, ',' order by wallet_address) into got from proposal_electorate(c, 'members', 12, 0, '{}', now());
  if got <> 'admin,lead,member,paid' then raise exception 'members electorate: %', got; end if;
  select string_agg(wallet_address, ',' order by wallet_address) into got from proposal_electorate(c, 'members', 12, 30, '{}', now());
  if got <> 'admin,lead,member' then raise exception 'min membership age: %', got; end if;
  select string_agg(wallet_address, ',' order by wallet_address) into got from proposal_electorate(c, 'admins', 12, 0, '{}', now());
  if got <> 'admin' then raise exception 'admins electorate: %', got; end if;
  select string_agg(wallet_address, ',' order by wallet_address) into got from proposal_electorate(c, 'managers', 12, 0, '{}', now());
  if got <> 'admin,lead' then raise exception 'managers electorate: %', got; end if;
  select string_agg(wallet_address, ',' order by wallet_address) into got from proposal_electorate(c, 'workgroup', 12, 0, dev, now());
  if got <> 'lead,paid' then raise exception 'workgroup electorate: %', got; end if;
  select coalesce(string_agg(wallet_address, ','), '') into got from proposal_electorate(c, 'workgroup', 12, 0, docs, now());
  if got <> '' then raise exception 'a rejected payout made a voter: %', got; end if;
  select string_agg(wallet_address, ',' order by wallet_address) into got from proposal_electorate(c, 'contributors', 12, 0, '{}', now());
  if got <> 'paid' then raise exception 'contributors electorate: %', got; end if;
  select coalesce(string_agg(wallet_address, ','), '') into got from proposal_electorate(c, 'contributors', 1, 0, '{}', now());
  if got <> '' then raise exception 'activity window ignored: %', got; end if;
  -- An assignee of a concerned workgroup's recent task votes on it.
  insert into task_assignees(task_id, source, wallet_address) values ('30000000-0000-0000-0000-000000000002', 'manual', 'member');
  select string_agg(wallet_address, ',' order by wallet_address) into got from proposal_electorate(c, 'workgroup', 12, 0, docs, now());
  if got <> 'member' then raise exception 'assignee electorate: %', got; end if;
  -- No concerned workgroup: the contributors.
  select string_agg(wallet_address, ',' order by wallet_address) into got from proposal_electorate(c, 'workgroup', 12, 0, '{}', now());
  if got <> 'paid' then raise exception 'workgroup fallback: %', got; end if;
end $$;

-- 2. Creating and opening.
do $$
declare
  p1 uuid; p2 uuid; p3 uuid; r record;
begin
  p1 := pg_temp.propose('decision', pg_temp.rules());
  select * into r from proposals where id = p1;
  if r.number <> 1 or r.state <> 'voting' or r.electorate_size <> 4 or r.closes_at <> now() + interval '72 hours' then
    raise exception 'a proposal without discussion did not open: %', row_to_json(r);
  end if;
  if exists (select 1 from proposal_voters where proposal_id = p1 and wallet_address = 'newbie') then
    raise exception 'a member who joined later was snapshotted';
  end if;
  p2 := pg_temp.propose('decision', pg_temp.rules('{"discussionHours":48}'));
  select * into r from proposals where id = p2;
  if r.number <> 2 or r.state <> 'discussion' or r.voting_starts_at <> now() + interval '48 hours' then
    raise exception 'discussion period ignored: %', row_to_json(r);
  end if;
  if open_proposal_voting(p2) <> 'discussion' then raise exception 'voting opened early'; end if;
  update proposals set voting_starts_at = now() where id = p2;
  if open_proposal_voting(p2) <> 'voting' then raise exception 'voting did not open'; end if;
  -- Nobody qualifies: cancelled with a reason.
  p3 := pg_temp.propose('decision', pg_temp.rules('{"minMemberDays":365}'));
  select * into r from proposals where id = p3;
  if r.state <> 'cancelled' or r.end_reason <> 'No eligible voters' then raise exception 'empty electorate: %', r.state; end if;
  -- Recusal: the beneficiary is on the list but cannot vote and is not counted.
  p3 := pg_temp.propose('decision', pg_temp.rules('{"recuseBeneficiaries":true}'), beneficiaries => array['lead']);
  if (select electorate_size from proposals where id = p3) <> 3 then raise exception 'recused voter counted'; end if;
  perform pg_temp.reject(format('select pg_temp.vote(%L, ''lead'', ''yes'')', p3), '42501');
  perform pg_temp.reject($q$ select pg_temp.propose('decision', pg_temp.rules(), 'outsider') $q$, '42501');
end $$;

-- 3. Ballots.
do $$
declare
  p uuid := (select id from proposals where number = 1);
  lazy uuid;
  consent uuid;
  t timestamptz := clock_timestamp();
begin
  if pg_temp.vote(p, 'member', 'yes', null, t) <> 1 then raise exception 'ballot not counted'; end if;
  -- Changing a vote replaces it; an older ballot cannot undo the change.
  perform pg_temp.vote(p, 'member', 'no', null, t + interval '1 second');
  perform pg_temp.reject(format('select pg_temp.vote(%L, ''member'', ''yes'', null, %L)', p, t), '40001');
  if (select choice from proposal_votes where proposal_id = p and voter = 'member') <> 'no'
      or (select ballots_cast from proposals where id = p) <> 1 then
    raise exception 'changed vote not kept';
  end if;
  perform pg_temp.vote(p, 'admin', 'yes');
  if (select ballot_version from proposals where id = p) <> 3 then raise exception 'ballot version not bumped'; end if;
  perform pg_temp.reject(format('select pg_temp.vote(%L, ''newbie'', ''yes'')', p), '42501');
  perform pg_temp.reject(format('select pg_temp.vote(%L, ''outsider'', ''yes'')', p), '42501');
  perform pg_temp.reject(format('select pg_temp.vote(%L, ''lead'', ''agree'')', p), '23514');
  consent := pg_temp.propose('decision', pg_temp.rules('{"method":"consent"}'));
  perform pg_temp.reject(format('select pg_temp.vote(%L, ''lead'', ''block'', '' '')', consent), '23514');
  perform pg_temp.vote(consent, 'lead', 'block', 'Not safe to try');
  lazy := pg_temp.propose('decision', pg_temp.rules('{"method":"lazy"}'));
  perform pg_temp.reject(format('select pg_temp.vote(%L, ''lead'', ''object'')', lazy), '23514');
  perform pg_temp.reject(format('select pg_temp.vote(%L, ''lead'', ''yes'')', lazy), '23514');
  -- A member who left can no longer vote.
  delete from community_members where wallet_address = 'paid';
  perform pg_temp.reject(format('select pg_temp.vote(%L, ''paid'', ''yes'')', p), '42501');
  insert into community_members(community_id, wallet_address, role, created_at)
    values ('10000000-0000-0000-0000-000000000000', 'paid', 'member', now() - interval '5 days');
end $$;

-- 4. Ballots stay hidden until the close (RLS).
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
do $$ begin
  if (select count(*) from proposal_votes where proposal_id = (select id from proposals where number = 1)) <> 1 then
    raise exception 'a member sees other ballots while voting runs';
  end if;
  if (select ballots_cast from proposals where number = 1) <> 2 then raise exception 'turnout hidden'; end if;
  if (select count(*) from proposal_voters where proposal_id = (select id from proposals where number = 1)) <> 4 then
    raise exception 'electorate hidden';
  end if;
end $$;
select pg_temp.reject($q$ insert into proposals(community_id, number, kind, title, content_hash, rules, rules_hash, proposer, voting_starts_at)
  values ('10000000-0000-0000-0000-000000000000', 99, 'decision', 'x', repeat('a', 64), '{}', repeat('a', 64), 'member', now()) $q$, '42501');
select pg_temp.reject($q$ update proposal_votes set choice = 'yes' $q$, '42501');
select pg_temp.reject($q$ select cast_proposal_vote((select id from proposals where number = 1), 'member', 'yes', null, now(), 'x', 'a', 'b') $q$, '42501');
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"outsider"}', true);
do $$ begin
  if exists (select 1 from proposals) or exists (select 1 from proposal_votes) or exists (select 1 from proposal_voters) then
    raise exception 'an outsider reads proposals';
  end if;
end $$;
reset role;

-- 5. Closing.
do $$
declare
  p uuid := (select id from proposals where number = 1);
  v int := (select ballot_version from proposals where number = 1);
begin
  perform pg_temp.reject(format('select close_proposal(%L, %s, ''passed'', ''{}'', ''passed'')', p, v), '23514');
  perform pg_temp.expire(p);
  perform pg_temp.reject(format('select pg_temp.vote(%L, ''lead'', ''yes'')', p), '23514');
  perform pg_temp.reject(format('select close_proposal(%L, %s, ''passed'', ''{}'', ''passed'')', p, v - 1), '40001');
  if close_proposal(p, v, 'passed', '{"yes":1}', 'passed') <> 'passed' then raise exception 'not closed'; end if;
  if close_proposal(p, v, 'rejected', '{}', 'threshold') <> 'passed' then raise exception 'closed twice'; end if;
  -- A decision has nothing to carry out.
  if (select execution_state from proposals where id = p) <> 'not_applicable' then raise exception 'decision executes'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
do $$ begin
  if (select count(*) from proposal_votes where proposal_id = (select id from proposals where number = 1)) <> 2 then
    raise exception 'ballots hidden after the close';
  end if;
end $$;
reset role;

-- 6. Withdraw and cancel.
do $$
declare
  p uuid := pg_temp.propose('decision', pg_temp.rules('{"discussionHours":24}'));
  q uuid := pg_temp.propose('decision', pg_temp.rules());
begin
  perform pg_temp.reject(format('select end_proposal(%L, ''admin'', ''withdrawn'', null)', p), '42501');
  perform pg_temp.reject(format('select end_proposal(%L, ''member'', ''withdrawn'', null)', q), '23514');
  if end_proposal(p, 'member', 'withdrawn', null) <> 'withdrawn' then raise exception 'not withdrawn'; end if;
  perform pg_temp.reject(format('select end_proposal(%L, ''member'', ''cancelled'', ''No'')', q), '42501');
  perform pg_temp.reject(format('select end_proposal(%L, ''admin'', ''cancelled'', '' '')', q), '23514');
  if end_proposal(q, 'admin', 'cancelled', 'Duplicate') <> 'cancelled' then raise exception 'not cancelled'; end if;
  perform pg_temp.reject(format('select end_proposal(%L, ''admin'', ''cancelled'', ''Again'')', q), '23514');
end $$;

-- 7. Budget consent.
do $$
declare
  dev uuid := '20000000-0000-0000-0000-000000000003';
  month date := date_trunc('month', now() at time zone 'UTC')::date;
  owners jsonb := jsonb_build_array(jsonb_build_object('workgroupId', dev, 'baseRevision', 0));
  steps jsonb := jsonb_build_array(jsonb_build_object('workgroupId', dev, 'mode', 'recurring', 'cadence', 'monthly',
    'startsOn', month, 'amounts', pg_temp.ada('100'), 'confirm', false, 'reason', 'Opening budget'));
  rules jsonb := pg_temp.rules('{"method":"consent"}');
  p uuid;
  q uuid;
begin
  insert into governance_settings(community_id, kind, enabled, proposers, electorate, method, quorum_pct,
      threshold_pct, discussion_hours, voting_hours, updated_by)
    values ('10000000-0000-0000-0000-000000000000', 'budget', true, 'managers', 'members', 'consent', 25, 50, 0, 72, 'admin');
  perform pg_temp.reject(format('select save_budget_setup(%L, 0, ''recurring'', ''monthly'', %L, %L, ''admin'')',
    dev, month, pg_temp.ada('1')), '42501');
  -- The dry run leaves nothing behind.
  perform check_budget_proposal(owners, steps, 'lead');
  if exists (select 1 from budget_setups) or exists (select 1 from budget_setup_states) or exists (select 1 from budget_changes) then
    raise exception 'the dry run wrote budgets';
  end if;
  perform pg_temp.reject(format('select check_budget_proposal(%L, %L, ''lead'')',
    jsonb_build_array(jsonb_build_object('workgroupId', dev, 'baseRevision', 3)), steps), '40001');
  p := pg_temp.propose('budget', rules, 'lead', array[dev], array['lead'], jsonb_build_object('steps', steps), owners);
  perform pg_temp.reject(format('select pg_temp.propose(''budget'', %L, ''admin'', %L, ''{}'', %L, %L)',
    rules, array[dev], jsonb_build_object('steps', steps), owners), '23505');
  perform pg_temp.vote(p, 'admin', 'agree');
  perform pg_temp.expire(p);
  perform close_proposal(p, 1, 'passed', '{}', 'passed');
  if execute_proposal(p) <> 'applied' then raise exception 'budget proposal not applied'; end if;
  if (select count(*) from budget_setups where workgroup_id = dev) <> 1
      or (select reason from budget_changes where workgroup_id = dev) <> 'Proposal #' || (select number from proposals where id = p) || ': Opening budget'
      or (select changed_by from budget_changes where workgroup_id = dev) <> 'lead' then
    raise exception 'budget proposal applied wrongly';
  end if;
  -- Counted in a statement of its own: a query does not see what a function it calls has just written.
  if execute_proposal(p) <> 'applied' then raise exception 'a second execute did not answer applied'; end if;
  if (select count(*) from budget_changes) <> 1 then raise exception 'applied twice'; end if;
  if exists (select 1 from proposal_budget_owners where active) then raise exception 'owner still locked'; end if;

  -- The budgets moved after the proposal was made: nothing applies, the failure is recorded.
  owners := jsonb_build_array(jsonb_build_object('workgroupId', dev, 'baseRevision', 1));
  steps := jsonb_set(steps, '{0,amounts}', pg_temp.ada('200'));
  q := pg_temp.propose('budget', rules, 'lead', array[dev], '{}', jsonb_build_object('steps', steps), owners);
  perform set_config('guild_vault.proposal_apply', 'test', true);
  update budget_setup_states set revision = revision + 1 where workgroup_id = dev;
  perform set_config('guild_vault.proposal_apply', '', true);
  perform pg_temp.vote(q, 'admin', 'agree');
  perform pg_temp.expire(q);
  perform close_proposal(q, 1, 'passed', '{}', 'passed');
  if execute_proposal(q) <> 'failed' then raise exception 'a stale budget proposal applied'; end if;
  if (select execution_error from proposals where id = q) not like 'The budgets of Ops changed%'
      or (select count(*) from budget_changes) <> 1
      or not exists (select 1 from proposal_events where proposal_id = q and action = 'execution_failed') then
    raise exception 'failed execution not recorded cleanly';
  end if;
  -- The sweep does not retry a failure; an admin retry fails again for the same reason.
  if execute_proposal(q) <> 'failed' or execute_proposal(q, 'admin') <> 'failed' then raise exception 'retry'; end if;

  -- A reset is a budget change too.
  perform pg_temp.reject(format('select reset_workgroup_budgets(%L, 2, ''admin'', ''Ops'', ''Mistake'')', dev), '42501');
  -- Consent off: direct saves work again.
  update governance_settings set enabled = false where kind = 'budget';
  perform save_budget_setup(dev, 2, 'recurring', 'monthly', month, pg_temp.ada('300'), 'admin');
end $$;

-- 8. Settings saves are logged.
do $$ begin
  perform save_governance_settings('10000000-0000-0000-0000-000000000000', 'decision',
    '{"enabled":true,"proposers":"members","electorate":"members","activity_months":12,"min_member_days":0,
      "method":"majority","quorum_pct":20,"threshold_pct":50,"lazy_objections":1,"discussion_hours":48,
      "voting_hours":120,"hide_results":true,"recuse_beneficiaries":false}', 'admin');
  perform save_governance_settings('10000000-0000-0000-0000-000000000000', 'decision',
    '{"enabled":false,"proposers":"members","electorate":"members","activity_months":12,"min_member_days":0,
      "method":"majority","quorum_pct":20,"threshold_pct":50,"lazy_objections":1,"discussion_hours":48,
      "voting_hours":120,"hide_results":true,"recuse_beneficiaries":false}', 'admin');
  if governance_enabled('10000000-0000-0000-0000-000000000000', 'decision')
      or (select count(*) from governance_setting_changes where kind = 'decision') <> 2
      or (select before_value->>'enabled' from governance_setting_changes where kind = 'decision'
        order by changed_at desc, after_value->>'enabled' limit 1) <> 'true' then
    raise exception 'settings change not logged';
  end if;
  perform pg_temp.reject($q$ select save_governance_settings('10000000-0000-0000-0000-000000000000', 'decision',
    '{"enabled":true,"proposers":"everyone","electorate":"members","activity_months":12,"min_member_days":0,"method":"majority","quorum_pct":20,"lazy_objections":1,"hide_results":true,"recuse_beneficiaries":false,
      "threshold_pct":50,"discussion_hours":48,"voting_hours":120}', 'admin') $q$, '23514');
end $$;

rollback;
\echo Governance tests passed.
