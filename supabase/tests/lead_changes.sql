-- Migration 0083: lead-change proposals and an admin's immediate removal.
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
\ir ../migrations/0071_governance_discord_channels.sql
\ir ../migrations/0083_lead_changes.sql

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

create function pg_temp.passed(title text, payload jsonb) returns uuid language plpgsql as $$
declare pid uuid;
begin
  pid := (create_proposal('10000000-0000-0000-0000-000000000000', 'lead', title, 'Why', null, payload,
    repeat('a', 64), '{"method":"majority","electorate":"members","activityMonths":12,"minMemberDays":0,
      "quorumPct":0,"thresholdPct":50,"lazyObjections":1,"discussionHours":0,"votingHours":72,
      "hideResults":true,"recuseBeneficiaries":true}', repeat('b', 64),
    array['20000000-0000-0000-0000-000000000001']::uuid[], array['extra'], 'admin')->>'id')::uuid;
  update proposals set state = 'voting', voting_opened_at = now(), closes_at = now() - interval '1 second' where id = pid;
  perform close_proposal(pid, 0, 'passed', '{}', 'passed');
  return pid;
end $$;

insert into contributors(wallet_address) values ('admin'), ('member'), ('extra'), ('gone');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin');
insert into community_members(community_id, wallet_address, role, created_at) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner', now() - interval '9 days'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member', now() - interval '9 days'),
  ('10000000-0000-0000-0000-000000000000', 'extra', 'member', now() - interval '9 days');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Dev', 'native'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Repo', 'github');
insert into workgroup_leads(workgroup_id, wallet_address) values
  ('20000000-0000-0000-0000-000000000001', 'member');

-- 1. The leads electorate is the current leads who were members at the cutoff.
do $$
declare names text;
begin
  select string_agg(wallet_address, ',' order by wallet_address) into names from proposal_electorate(
    '10000000-0000-0000-0000-000000000000', 'leads', 12, 0,
    array['20000000-0000-0000-0000-000000000001']::uuid[], now());
  if names is distinct from 'member' then raise exception 'leads electorate was %', names; end if;
end $$;

-- 2. Apply adds a member and removes a lead. A departed wallet fails the apply
-- and changes nothing. A second execute is idempotent. An archived workgroup fails.
do $$
declare
  pid uuid;
  spec jsonb := jsonb_build_object('leadChange', jsonb_build_object(
    'workgroupId', '20000000-0000-0000-0000-000000000001',
    'add', jsonb_build_array('extra'), 'remove', jsonb_build_array('member'),
    'escalation', null, 'escalates', null));
begin
  pid := pg_temp.passed('Gone', jsonb_set(spec, '{leadChange,add}', '["gone"]'::jsonb));
  if execute_proposal(pid) <> 'failed'
      or (select execution_error from proposals where id = pid) <> 'A proposed lead is no longer a member'
      or (select string_agg(wallet_address, ',') from workgroup_leads) <> 'member' then
    raise exception 'a departed lead was applied: %', (select execution_error from proposals where id = pid);
  end if;

  pid := pg_temp.passed('Swap', spec);
  if execute_proposal(pid) <> 'applied' then
    raise exception 'lead change not applied: %', (select execution_error from proposals where id = pid);
  end if;
  if (select string_agg(wallet_address, ',') from workgroup_leads where workgroup_id = '20000000-0000-0000-0000-000000000001') <> 'extra' then
    raise exception 'leads not swapped';
  end if;
  if execute_proposal(pid) <> 'applied' then raise exception 'a second execute did not answer applied'; end if;

  update workgroups set archived_at = now() where id = '20000000-0000-0000-0000-000000000001';
  pid := pg_temp.passed('Archived', spec);
  if execute_proposal(pid) <> 'failed' then raise exception 'an archived workgroup accepted a lead change'; end if;
  update workgroups set archived_at = null where id = '20000000-0000-0000-0000-000000000001';
end $$;

-- 3. One open lead change per workgroup.
do $$
declare
  payload jsonb := jsonb_build_object('leadChange', jsonb_build_object(
    'workgroupId', '20000000-0000-0000-0000-000000000002', 'add', '[]'::jsonb, 'remove', '[]'::jsonb,
    'escalation', null, 'escalates', null));
  rules jsonb := '{"discussionHours":24,"electorate":"members","activityMonths":12,"minMemberDays":0,"votingHours":72}'::jsonb;
begin
  perform create_proposal('10000000-0000-0000-0000-000000000000', 'lead', 'First', '', null, payload,
    repeat('c', 64), rules, repeat('d', 64), array['20000000-0000-0000-0000-000000000002']::uuid[], '{}', 'admin');
end $$;
select pg_temp.reject($sql$
  select create_proposal('10000000-0000-0000-0000-000000000000', 'lead', 'Second', '', null,
    jsonb_build_object('leadChange', jsonb_build_object(
      'workgroupId', '20000000-0000-0000-0000-000000000002', 'add', '[]'::jsonb, 'remove', '[]'::jsonb,
      'escalation', null, 'escalates', null)),
    repeat('e', 64), '{"discussionHours":24}'::jsonb, repeat('f', 64), array['20000000-0000-0000-0000-000000000002']::uuid[], '{}', 'admin')
$sql$, '23505');

-- 4. An admin's immediate removal records the reason and drops the lead.
-- Someone who is not a lead is refused.
do $$
begin
  perform remove_workgroup_lead_override(
    '20000000-0000-0000-0000-000000000001', 'extra', 'admin', 'Left the team');
  if exists (select 1 from workgroup_leads where wallet_address = 'extra') then
    raise exception 'the lead was not removed';
  end if;
  if (select reason from workgroup_lead_overrides where wallet_address = 'extra') <> 'Left the team' then
    raise exception 'the reason was not recorded';
  end if;
end $$;
select pg_temp.reject($sql$
  select remove_workgroup_lead_override('20000000-0000-0000-0000-000000000001', 'member', 'admin', 'No')
$sql$, '23514');

-- 5. Members can read the record. Other wallets and the anonymous role cannot
-- write it, and a non-member cannot read it.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
do $$
begin
  if (select count(*) from workgroup_lead_overrides) <> 1 then raise exception 'a member could not read the removal'; end if;
end $$;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"stranger"}', true);
do $$
begin
  if (select count(*) from workgroup_lead_overrides) <> 0 then raise exception 'a non-member read a lead removal'; end if;
end $$;
select pg_temp.reject($sql$
  insert into workgroup_lead_overrides(community_id, workgroup_id, wallet_address, actor, reason)
    values ('10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001', 'extra', 'member', 'no')
$sql$, '42501');

rollback;
