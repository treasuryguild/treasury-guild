-- Migrations 0056-0057: workgroup and task proposals, proposal announcements.
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

-- A proposal that passed: made, voted on by the admin, closed.
create function pg_temp.passed(kind text, title text, payload jsonb, proposer text default 'member') returns uuid
language plpgsql as $$
declare pid uuid;
begin
  pid := (create_proposal('10000000-0000-0000-0000-000000000000', kind, title, 'Why', null, payload,
    repeat('a', 64), '{"method":"majority","electorate":"members","activityMonths":12,"minMemberDays":0,
      "quorumPct":0,"thresholdPct":50,"lazyObjections":1,"discussionHours":0,"votingHours":72,
      "hideResults":true,"recuseBeneficiaries":false}', repeat('b', 64), '{}', '{}', proposer)->>'id')::uuid;
  perform cast_proposal_vote(pid, 'admin', 'yes', null, clock_timestamp(), 'ballot', 'a1', 'b2');
  update proposals set closes_at = now() - interval '1 second' where id = pid;
  perform close_proposal(pid, 1, 'passed', '{}', 'passed');
  return pid;
end $$;

insert into contributors(wallet_address) values ('admin'), ('member'), ('gone');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin');
insert into community_members(community_id, wallet_address, role, created_at) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner', now() - interval '9 days'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member', now() - interval '9 days');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Dev', 'native'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Repo', 'github');
insert into board_columns(id, workgroup_id, name, position, marks_payable, marks_paid) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Audited', 0, true, false),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Backlog', 1, false, false);

-- 1. A new workgroup, with its board and the leads who are still members.
do $$
declare
  columns jsonb := '[{"name":"To Do","position":0,"marks_payable":false,"marks_paid":false},
    {"name":"Audited","position":1,"marks_payable":true,"marks_paid":false},
    {"name":"Paid","position":2,"marks_payable":false,"marks_paid":true}]';
  pid uuid;
  wid uuid;
begin
  pid := pg_temp.passed('workgroup', 'New workgroup: Design', jsonb_build_object('columns', columns,
    'workgroup', jsonb_build_object('name', ' Design ', 'description', 'UI work', 'leads', jsonb_build_array('member', 'gone'))));
  if execute_proposal(pid) <> 'applied' then raise exception 'workgroup not created: %', (select execution_error from proposals where id = pid); end if;
  wid := (select (execution_result->>'workgroupId')::uuid from proposals where id = pid);
  if (select name || '|' || description || '|' || kind from workgroups where id = wid) <> 'Design|UI work|native' then
    raise exception 'workgroup created wrongly';
  end if;
  if (select string_agg(name, ',' order by position) from board_columns where workgroup_id = wid) <> 'To Do,Audited,Paid' then
    raise exception 'board columns not created';
  end if;
  if (select string_agg(wallet_address, ',') from workgroup_leads where workgroup_id = wid) <> 'member' then
    raise exception 'leads wrong: only current members lead';
  end if;
  if (select detail->>'workgroupId' from proposal_events where proposal_id = pid and action = 'executed') <> wid::text then
    raise exception 'result not in the history';
  end if;
  -- The same name again: nothing is created, the failure is recorded.
  pid := pg_temp.passed('workgroup', 'Again', jsonb_build_object('columns', columns, 'workgroup', jsonb_build_object('name', 'design')));
  if execute_proposal(pid) <> 'failed' or (select count(*) from workgroups where lower(name) = 'design') <> 1
      or (select execution_error from proposals where id = pid) <> 'A workgroup named design already exists' then
    raise exception 'duplicate workgroup name not refused';
  end if;
end $$;

-- 2. A proposed task lands in the first column that is neither payable nor paid.
do $$
declare
  pid uuid;
  tid uuid;
  task jsonb := jsonb_build_object('workgroupId', '20000000-0000-0000-0000-000000000001', 'amounts', '{"ADA":"150"}'::jsonb,
    'bountyLovelace', '150000000', 'assignSelf', true);
begin
  pid := pg_temp.passed('task', 'Write the onboarding guide', jsonb_build_object('task', task));
  if execute_proposal(pid) <> 'applied' then raise exception 'task not created: %', (select execution_error from proposals where id = pid); end if;
  tid := (select (execution_result->>'taskId')::uuid from proposals where id = pid);
  if (select title || '|' || body || '|' || column_id || '|' || pay_state || '|' || bounty_lovelace || '|' || (amounts->>'ADA') || '|' || (number > 0)
      from tasks where id = tid) <> 'Write the onboarding guide|Why|30000000-0000-0000-0000-000000000002|none|150000000|150|true' then
    raise exception 'task created wrongly: %', (select row_to_json(t) from tasks t where id = tid);
  end if;
  if (select string_agg(wallet_address || ':' || source, ',') from task_assignees where task_id = tid) <> 'member:manual' then
    raise exception 'proposer not assigned';
  end if;
  -- Not on a GitHub board, not on an archived one.
  pid := pg_temp.passed('task', 'On GitHub', jsonb_build_object('task', task || '{"workgroupId":"20000000-0000-0000-0000-000000000002"}'::jsonb));
  if execute_proposal(pid) <> 'failed' then raise exception 'task added to a GitHub board'; end if;
  update workgroups set archived_at = now() where id = '20000000-0000-0000-0000-000000000001';
  pid := pg_temp.passed('task', 'Archived', jsonb_build_object('task', task));
  if execute_proposal(pid) <> 'failed' or (select count(*) from tasks) <> 1 then raise exception 'task added to an archived board'; end if;
  update workgroups set archived_at = null where id = '20000000-0000-0000-0000-000000000001';
  -- An admin retry after the restore succeeds.
  if execute_proposal(pid, 'admin') <> 'applied' then raise exception 'retry after restore failed'; end if;
end $$;

-- 3. While the workgroup kind is on, admins cannot create workgroups directly.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
insert into workgroups(community_id, name) values ('10000000-0000-0000-0000-000000000000', 'Direct');
reset role;
insert into governance_settings(community_id, kind, enabled, proposers, electorate, method, quorum_pct,
    threshold_pct, discussion_hours, voting_hours, updated_by)
  values ('10000000-0000-0000-0000-000000000000', 'workgroup', true, 'members', 'members', 'majority', 20, 50, 48, 120, 'admin');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
select pg_temp.reject($q$ insert into workgroups(community_id, name) values ('10000000-0000-0000-0000-000000000000', 'Direct 2') $q$, '42501');
reset role;

-- 4. The announcements webhook URL is a secret: no member reads it, even an admin.
insert into governance_discord_webhooks(community_id, url, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'https://discord.com/api/webhooks/1/secret', 'admin');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
select pg_temp.reject($q$ select * from governance_discord_webhooks $q$, '42501');
do $$ begin
  if (select count(*) from proposals where discord_milestone is not null) <> 0 then
    raise exception 'milestones set without a webhook';
  end if;
end $$;
reset role;
select pg_temp.reject($q$ update proposals set discord_milestone = 'later' $q$, '23514');

rollback;
\echo Governance workgroup and task proposal tests passed.
