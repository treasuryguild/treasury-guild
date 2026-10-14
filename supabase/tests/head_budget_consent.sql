-- Head schema (migrations 0001-0065): budget consent. Direct budget saves with
-- the budget kind off and on, and budget proposals carried out by the current
-- execute_proposal. Run with psql -f against an EMPTY disposable PostgreSQL
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
-- A refusal by guard_budget_consent itself: 42501 with its own message (the
-- RPCs raise 42501 for other reasons too, e.g. a reset by a non-admin).
create function pg_temp.consent_refuses(command text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = '42501' and sqlerrm = 'This community changes budgets by proposal' then return; end if;
    raise;
  end;
  raise exception 'Budget consent did not refuse: %', command;
end $$;
create function pg_temp.ada(value text) returns jsonb language sql as
  $$ select jsonb_build_array(jsonb_build_object('unit', 'lovelace', 'amount', value, 'asset_label', 'ADA', 'decimals', 6)) $$;
create function pg_temp.rev(owner text) returns integer language sql as
  $$ select coalesce((select revision from budget_setup_states where owner_key = owner), 0) $$;
-- Everything a budget save can write, as one comparable value.
create function pg_temp.budget_fingerprint() returns text language sql as $$
  select md5(coalesce((select string_agg(to_jsonb(s)::text, '|' order by s.id) from budget_setups s), '')
    || '#' || coalesce((select string_agg(to_jsonb(p)::text, '|' order by p.setup_id, p.starts_on) from budget_plans p), '')
    || '#' || coalesce((select string_agg(to_jsonb(st)::text, '|' order by st.owner_key) from budget_setup_states st), '')
    || '#' || coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.id) from budget_changes c), ''))
$$;
-- A budget proposal as the app makes it: consent method, no discussion period.
create function pg_temp.propose_budget(owners jsonb, steps jsonb, workgroups uuid[]) returns uuid language sql as $$
  select (create_proposal('10000000-0000-0000-0000-000000000000', 'budget', 'Budget change', 'Why', null,
    jsonb_build_object('steps', steps), repeat('a', 64),
    '{"method":"consent","electorate":"members","activityMonths":12,"minMemberDays":0,"quorumPct":20,
      "thresholdPct":50,"lazyObjections":1,"discussionHours":0,"votingHours":72,"hideResults":true,
      "recuseBeneficiaries":false}', repeat('b', 64), workgroups, '{}', 'lead', owners)->>'id')::uuid
$$;
-- The admin's ballot, then the deadline passes and the outcome is recorded.
create function pg_temp.vote_and_close(pid uuid, choice text, outcome text) returns void language plpgsql as $$
begin
  perform cast_proposal_vote(pid, 'admin', choice, case when choice = 'block' then 'Not now' end,
    clock_timestamp(), 'ballot', 'a1', 'b2');
  update proposals set closes_at = now() - interval '1 second' where id = pid;
  if close_proposal(pid, 1, outcome, '{}', outcome) <> outcome then raise exception 'proposal not closed as %', outcome; end if;
end $$;

insert into contributors(wallet_address) values ('admin'), ('lead'), ('member'), ('outsider');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'Other', 0, 'outsider');
insert into community_members(community_id, wallet_address, role, created_at) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner', now() - interval '90 days'),
  ('10000000-0000-0000-0000-000000000000', 'lead', 'member', now() - interval '90 days'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member', now() - interval '90 days'),
  ('10000000-0000-0000-0000-000000000009', 'outsider', 'owner', now() - interval '90 days');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Dev', 'native'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Docs', 'native'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000', 'Ops', 'native'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000000', 'Past', 'native'),
  ('20000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000009', 'Elsewhere', 'native');
insert into workgroup_leads(workgroup_id, wallet_address) values ('20000000-0000-0000-0000-000000000001', 'lead');

-- Every call below is made the way the API routes make it: as the service role.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 1. Governance off: direct saves and the reset work as before 0055. ----------------
do $$
declare
  dev uuid := '20000000-0000-0000-0000-000000000001';
  past uuid := '20000000-0000-0000-0000-000000000004';
  main uuid := '40000000-0000-0000-0000-000000000001';
  month date := date_trunc('month', now() at time zone 'UTC')::date;
  earlier date := (date_trunc('month', now() at time zone 'UTC') - interval '6 months')::date;
  r integer;
begin
  if governance_enabled('10000000-0000-0000-0000-000000000000', 'budget') then raise exception 'budget consent on by default'; end if;
  -- A workgroup owner.
  r := save_budget_setup(dev, 0, 'recurring', 'monthly', month, pg_temp.ada('100'), 'admin');
  if r <> 1 or (select amounts->0->>'amount' from budget_setups where workgroup_id = dev) <> '100' then
    raise exception 'direct workgroup save failed with governance off (revision %)', r;
  end if;
  -- A treasury owner (0036 p_treasury_id).
  r := save_budget_setup(null, 0, 'recurring', 'monthly', month, pg_temp.ada('200'), 'admin', false, null, main);
  if r <> 1 or not exists (select 1 from budget_setups where treasury_id = main and workgroup_id is null
      and owner_key = 't:' || main::text and amounts->0->>'amount' = '200') then
    raise exception 'direct treasury save failed with governance off (revision %)', r;
  end if;
  -- A backfill before the owner's first setup (0051): needs a reason, keeps the first setup.
  r := save_budget_setup(past, 0, 'recurring', 'monthly', month, pg_temp.ada('300'), 'admin');
  perform pg_temp.reject(format('select save_budget_setup(%L, 1, ''recurring'', ''monthly'', %L, %L, ''admin'')',
    past, earlier, pg_temp.ada('30')), '23514');
  r := save_budget_setup(past, 1, 'recurring', 'monthly', earlier, pg_temp.ada('30'), 'admin', false, 'Before the move');
  if r <> 2 or (select count(*) from budget_setups where workgroup_id = past) <> 2
      or (select amounts->0->>'amount' from budget_setups where workgroup_id = past and starts_on = month) <> '300'
      or (select reason from budget_changes where workgroup_id = past and effective_on = earlier) <> 'Before the move' then
    raise exception 'backfill failed with governance off (revision %)', r;
  end if;
  -- The reset.
  r := reset_workgroup_budgets(past, 2, 'admin', 'Past', 'Start over');
  if r <> 3 or exists (select 1 from budget_setups where workgroup_id = past)
      or exists (select 1 from budget_changes where workgroup_id = past) then
    raise exception 'reset failed with governance off (revision %)', r;
  end if;
  -- A settings row that is switched off, and another kind switched on, change nothing.
  perform save_governance_settings('10000000-0000-0000-0000-000000000000', 'budget',
    '{"enabled":false,"proposers":"managers","electorate":"members","activity_months":12,"min_member_days":0,
      "method":"consent","quorum_pct":20,"threshold_pct":50,"lazy_objections":1,"discussion_hours":0,
      "voting_hours":72,"hide_results":true,"recuse_beneficiaries":false}', 'admin');
  perform save_governance_settings('10000000-0000-0000-0000-000000000000', 'decision',
    '{"enabled":true,"proposers":"members","electorate":"members","activity_months":12,"min_member_days":0,
      "method":"majority","quorum_pct":20,"threshold_pct":50,"lazy_objections":1,"discussion_hours":0,
      "voting_hours":72,"hide_results":true,"recuse_beneficiaries":false}', 'admin');
  r := save_budget_setup(dev, 1, 'recurring', 'monthly', month, pg_temp.ada('150'), 'admin');
  if r <> 2 then raise exception 'a disabled budget kind blocked a direct save'; end if;
end $$;

-- 2. Budget consent on: every direct budget write is refused. -------------------------
do $$
declare
  dev uuid := '20000000-0000-0000-0000-000000000001';
  docs uuid := '20000000-0000-0000-0000-000000000002';
  elsewhere uuid := '20000000-0000-0000-0000-000000000009';
  main uuid := '40000000-0000-0000-0000-000000000001';
  month date := date_trunc('month', now() at time zone 'UTC')::date;
  earlier date := (date_trunc('month', now() at time zone 'UTC') - interval '6 months')::date;
  before text;
begin
  perform save_governance_settings('10000000-0000-0000-0000-000000000000', 'budget',
    '{"enabled":true,"proposers":"managers","electorate":"members","activity_months":12,"min_member_days":0,
      "method":"consent","quorum_pct":20,"threshold_pct":50,"lazy_objections":1,"discussion_hours":0,
      "voting_hours":72,"hide_results":true,"recuse_beneficiaries":false}', 'admin');
  if not governance_enabled('10000000-0000-0000-0000-000000000000', 'budget') then raise exception 'budget consent not on'; end if;
  before := pg_temp.budget_fingerprint();
  -- Workgroup owner: an edit of the setup in force, and a first setup.
  perform pg_temp.consent_refuses(format('select save_budget_setup(%L, 2, ''recurring'', ''monthly'', %L, %L, ''admin'')',
    dev, month, pg_temp.ada('1')));
  perform pg_temp.consent_refuses(format('select save_budget_setup(%L, 0, ''recurring'', ''monthly'', %L, %L, ''admin'')',
    docs, month, pg_temp.ada('1')));
  -- Treasury owner.
  perform pg_temp.consent_refuses(format('select save_budget_setup(null, 1, ''recurring'', ''monthly'', %L, %L, ''admin'', false, null, %L)',
    month, pg_temp.ada('1'), main));
  -- Backfill.
  perform pg_temp.consent_refuses(format('select save_budget_setup(%L, 2, ''recurring'', ''monthly'', %L, %L, ''admin'', false, ''Before the move'')',
    dev, earlier, pg_temp.ada('1')));
  -- Reset (by an admin, with the right name and revision: only consent stands in the way).
  perform pg_temp.consent_refuses(format('select reset_workgroup_budgets(%L, 2, ''admin'', ''Dev'', ''Mistake'')', dev));
  -- The tables themselves, for any writer that skips the RPCs.
  perform pg_temp.consent_refuses(format('update budget_setups set amounts = ''[]'' where workgroup_id = %L', dev));
  perform pg_temp.consent_refuses(format('update budget_setup_states set revision = 9 where treasury_id = %L', main));
  perform pg_temp.consent_refuses(format('insert into budget_plans(setup_id, starts_on, amounts) select id, %L, ''[]'' from budget_setups where workgroup_id = %L',
    month, dev));
  if pg_temp.budget_fingerprint() <> before then raise exception 'a refused budget write left something behind'; end if;
  -- Another community, without budget consent, still saves directly.
  if save_budget_setup(elsewhere, 0, 'recurring', 'monthly', month, pg_temp.ada('7'), 'outsider') <> 1 then
    raise exception 'budget consent leaked into another community';
  end if;
end $$;

-- 3. A passed budget proposal applies all of its steps through execute_proposal (0056). ---
do $$
declare
  dev uuid := '20000000-0000-0000-0000-000000000001';
  docs uuid := '20000000-0000-0000-0000-000000000002';
  main uuid := '40000000-0000-0000-0000-000000000001';
  month date := date_trunc('month', now() at time zone 'UTC')::date;
  earlier date := (date_trunc('month', now() at time zone 'UTC') - interval '3 months')::date;
  owners jsonb := jsonb_build_array(
    jsonb_build_object('workgroupId', dev, 'baseRevision', 2),
    jsonb_build_object('treasuryId', main, 'baseRevision', 1),
    jsonb_build_object('workgroupId', docs, 'baseRevision', 0));
  steps jsonb := jsonb_build_array(
    jsonb_build_object('workgroupId', dev, 'mode', 'recurring', 'cadence', 'monthly', 'startsOn', month,
      'amounts', pg_temp.ada('500'), 'confirm', false, 'reason', 'Raise'),
    jsonb_build_object('treasuryId', main, 'mode', 'recurring', 'cadence', 'monthly', 'startsOn', month,
      'amounts', pg_temp.ada('900'), 'confirm', false, 'reason', null),
    -- Two steps for one owner chain its revision: a first setup, then a backfill before it.
    jsonb_build_object('workgroupId', docs, 'mode', 'recurring', 'cadence', 'monthly', 'startsOn', month,
      'amounts', pg_temp.ada('60'), 'confirm', false, 'reason', 'Opening budget'),
    jsonb_build_object('workgroupId', docs, 'mode', 'recurring', 'cadence', 'monthly', 'startsOn', earlier,
      'amounts', pg_temp.ada('40'), 'confirm', false, 'reason', 'Before the move'));
  p uuid;
  n int;
  changes bigint;
  rejected uuid;
begin
  -- The dry run the propose route makes writes nothing, consent or not.
  changes := (select count(*) from budget_changes);
  perform check_budget_proposal(owners, steps, 'lead');
  if (select count(*) from budget_changes) <> changes or pg_temp.rev('w:' || docs::text) <> 0 then
    raise exception 'the dry run wrote budgets';
  end if;
  p := pg_temp.propose_budget(owners, steps, array[dev, docs]);
  n := (select number from proposals where id = p);
  if (select state || '/' || electorate_size from proposals where id = p) <> 'voting/3'
      or (select count(*) from proposal_budget_owners where proposal_id = p and active) <> 3 then
    raise exception 'budget proposal not opened with its owners locked';
  end if;
  -- Not before it passed.
  perform pg_temp.reject(format('select execute_proposal(%L)', p), '23514');
  perform pg_temp.vote_and_close(p, 'agree', 'passed');
  if (select execution_state from proposals where id = p) <> 'pending' then raise exception 'passed budget proposal not pending'; end if;
  if execute_proposal(p) <> 'applied' then
    raise exception 'budget proposal not applied: %', (select execution_error from proposals where id = p);
  end if;
  if pg_temp.rev('w:' || dev::text) <> 3 or pg_temp.rev('t:' || main::text) <> 2 or pg_temp.rev('w:' || docs::text) <> 2 then
    raise exception 'revisions after the apply: dev %, main %, docs %',
      pg_temp.rev('w:' || dev::text), pg_temp.rev('t:' || main::text), pg_temp.rev('w:' || docs::text);
  end if;
  if (select amounts->0->>'amount' from budget_setups where workgroup_id = dev and starts_on = month) <> '500'
      or (select amounts->0->>'amount' from budget_setups where treasury_id = main and starts_on = month) <> '900'
      or (select string_agg(amounts->0->>'amount', ',' order by starts_on) from budget_setups where workgroup_id = docs) <> '40,60' then
    raise exception 'budget steps applied wrongly';
  end if;
  if (select count(*) from budget_changes) <> changes + 4
      or not exists (select 1 from budget_changes where workgroup_id = dev and reason = 'Proposal #' || n || ': Raise' and changed_by = 'lead')
      or not exists (select 1 from budget_changes where treasury_id = main and reason = 'Proposal #' || n and changed_by = 'lead')
      or not exists (select 1 from budget_changes where workgroup_id = docs and reason = 'Proposal #' || n || ': Before the move'
        and effective_on = earlier and changed_by = 'lead') then
    raise exception 'budget changes not attributed to the proposal and its proposer';
  end if;
  if (select execution_state || '/' || (executed_at is not null) || '/' || (execution_error is null) || '/' || (execution_result is null)
        from proposals where id = p) <> 'applied/true/true/true'
      or (select count(*) from proposal_events where proposal_id = p and action = 'executed') <> 1
      or exists (select 1 from proposal_budget_owners where proposal_id = p and active) then
    raise exception 'applied proposal recorded wrongly';
  end if;
  -- Carrying it out again changes nothing.
  -- (Side effects are checked in a statement of their own: a query does not
  -- see what a function it calls has just written.)
  if execute_proposal(p) <> 'applied' or execute_proposal(p, 'admin') <> 'applied' then
    raise exception 'an applied proposal changed state when carried out again';
  end if;
  if (select count(*) from budget_changes) <> changes + 4 or pg_temp.rev('w:' || dev::text) <> 3
      or (select count(*) from proposal_events where proposal_id = p and action in ('executed', 'execution_failed')) <> 1 then
    raise exception 'a budget proposal applied twice';
  end if;
  -- The pass the proposal held does not outlive it: direct saves are refused again.
  if coalesce(current_setting('treasury_guild.proposal_apply', true), '') <> '' then
    raise exception 'treasury_guild.proposal_apply still set after execute_proposal';
  end if;
  perform pg_temp.consent_refuses(format('select save_budget_setup(%L, 3, ''recurring'', ''monthly'', %L, %L, ''admin'')',
    dev, month, pg_temp.ada('1')));

  -- A proposal that did not pass is never carried out and frees its owners.
  rejected := pg_temp.propose_budget(jsonb_build_array(jsonb_build_object('workgroupId', dev, 'baseRevision', 3)),
    jsonb_build_array(steps->0), array[dev]);
  perform pg_temp.vote_and_close(rejected, 'block', 'rejected');
  perform pg_temp.reject(format('select execute_proposal(%L)', rejected), '23514');
  if (select execution_state from proposals where id = rejected) <> 'not_applicable'
      or exists (select 1 from proposal_budget_owners where proposal_id = rejected and active)
      or pg_temp.rev('w:' || dev::text) <> 3 then
    raise exception 'a rejected budget proposal was carried out or kept its lock';
  end if;
end $$;

-- 4. A failing budget proposal applies nothing and is recorded as failed. ------------------
do $$
declare
  dev uuid := '20000000-0000-0000-0000-000000000001';
  ops uuid := '20000000-0000-0000-0000-000000000003';
  month date := date_trunc('month', now() at time zone 'UTC')::date;
  owners jsonb := jsonb_build_array(
    jsonb_build_object('workgroupId', ops, 'baseRevision', 0),
    jsonb_build_object('workgroupId', dev, 'baseRevision', 3));
  -- The first step is fine; the second is a quarterly budget that starts in February.
  steps jsonb := jsonb_build_array(
    jsonb_build_object('workgroupId', ops, 'mode', 'recurring', 'cadence', 'monthly', 'startsOn', month,
      'amounts', pg_temp.ada('50'), 'confirm', false, 'reason', 'Opening budget'),
    jsonb_build_object('workgroupId', dev, 'mode', 'quarterly', 'cadence', 'quarterly', 'startsOn', '2031-02-01',
      'amounts', pg_temp.ada('70'), 'confirm', true, 'reason', 'Go quarterly'));
  q uuid;
  before text := pg_temp.budget_fingerprint();
  r record;
begin
  q := pg_temp.propose_budget(owners, steps, array[ops, dev]);
  perform pg_temp.vote_and_close(q, 'agree', 'passed');
  if execute_proposal(q) <> 'failed' then raise exception 'a budget proposal with a refused step applied'; end if;
  select * into r from proposals where id = q;
  if r.execution_state <> 'failed' or r.execution_error <> 'Choose a valid budget setup and period start'
      or r.executed_at is not null or r.execution_result is not null or r.state <> 'passed' then
    raise exception 'failed execution recorded wrongly: %/%', r.execution_state, r.execution_error;
  end if;
  -- All or nothing: the first step's save is rolled back with the second's refusal.
  if pg_temp.budget_fingerprint() <> before or exists (select 1 from budget_setups where workgroup_id = ops) then
    raise exception 'a failed budget proposal left budget writes behind';
  end if;
  if (select count(*) from proposal_events where proposal_id = q and action = 'execution_failed'
        and detail->>'code' = '23514' and detail->>'message' = 'Choose a valid budget setup and period start' and actor is null) <> 1
      or exists (select 1 from proposal_events where proposal_id = q and action = 'executed')
      or exists (select 1 from proposal_budget_owners where proposal_id = q and active) then
    raise exception 'failed execution not in the history, or owners still locked';
  end if;
  -- The sweep (no actor) never retries; an admin retry runs again and fails the same way.
  if execute_proposal(q) <> 'failed' then raise exception 'the sweep changed a failed proposal'; end if;
  if (select count(*) from proposal_events where proposal_id = q and action = 'execution_failed') <> 1 then
    raise exception 'the sweep retried a failed proposal';
  end if;
  if execute_proposal(q, 'admin') <> 'failed' then raise exception 'admin retry of a failed proposal did not fail again'; end if;
  if (select count(*) from proposal_events where proposal_id = q and action = 'execution_failed' and actor = 'admin') <> 1
      or (select count(*) from proposal_events where proposal_id = q and action = 'execution_failed') <> 2
      or pg_temp.budget_fingerprint() <> before then
    raise exception 'admin retry of a failed proposal went wrong';
  end if;
  -- The failure did not leave the consent pass set either.
  if coalesce(current_setting('treasury_guild.proposal_apply', true), '') <> '' then
    raise exception 'treasury_guild.proposal_apply still set after a failed execute_proposal';
  end if;
  perform pg_temp.consent_refuses(format('select save_budget_setup(%L, 0, ''recurring'', ''monthly'', %L, %L, ''admin'')',
    ops, month, pg_temp.ada('1')));
end $$;

-- 5. Consent off again: direct saves and the reset are back. -------------------------------
do $$
declare
  ops uuid := '20000000-0000-0000-0000-000000000003';
  month date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  perform save_governance_settings('10000000-0000-0000-0000-000000000000', 'budget',
    '{"enabled":false,"proposers":"managers","electorate":"members","activity_months":12,"min_member_days":0,
      "method":"consent","quorum_pct":20,"threshold_pct":50,"lazy_objections":1,"discussion_hours":0,
      "voting_hours":72,"hide_results":true,"recuse_beneficiaries":false}', 'admin');
  if save_budget_setup(ops, 0, 'recurring', 'monthly', month, pg_temp.ada('50'), 'admin') <> 1 then
    raise exception 'direct saves did not come back with consent off';
  end if;
  if reset_workgroup_budgets(ops, 1, 'admin', 'Ops', 'Start over') <> 2 then
    raise exception 'the reset did not come back with consent off';
  end if;
  if exists (select 1 from budget_setups where workgroup_id = ops) then raise exception 'the reset kept the setups'; end if;
end $$;
reset role;

rollback;
\echo Head budget consent tests passed.
