-- Head schema (migrations 0001-0065): the two Signius seeds still load, rerun
-- and coexist. signius_sandbox_seed.sql and signius_live_seed.sql stop at 0033
-- and 0035; this is the lighter check against everything since. Run with
-- psql -f against an EMPTY disposable PostgreSQL database; everything is
-- rolled back.
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

-- Fixture: Signius (preprod) with three members, a submitted GVTT mint on its
-- first treasury, an older second treasury for the quarterly live workgroup,
-- another community, and tasks neither seed may touch.
insert into contributors(wallet_address) values
  ('seed-admin'), ('owner-wallet'), ('admin-wallet-1'), ('admin-wallet-2'), ('outsider');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000001', 'signius', 'Signius', 0, 'seed-admin'),
  ('10000000-0000-0000-0000-000000000002', 'other-community', 'Other', 0, 'seed-admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000001', 'owner-wallet', 'owner'),
  ('10000000-0000-0000-0000-000000000001', 'admin-wallet-1', 'admin'),
  ('10000000-0000-0000-0000-000000000001', 'admin-wallet-2', 'admin'),
  ('10000000-0000-0000-0000-000000000002', 'outsider', 'owner');
insert into treasuries(id, community_id, name, network, required, address, script_cbor, created_at) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Test treasury', 0, 1, 'test-treasury', '00', now() - interval '3 days'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Quarterly treasury', 0, 1, 'quarterly-treasury', '00', now() - interval '2 days');
insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'mint', '00', 'seed-admin', 1);
insert into mints(transaction_id, community_id, treasury_id, asset_kind, policy_id,
  policy_script, policy_script_cbor, asset_name, asset_name_hex, quantity, decimals,
  ticker, recipient, metadata, created_by) values (
  '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001', 'ft', repeat('a',56), '{}', '00',
  'Test Token', encode(convert_to('Test Token','UTF8'),'hex'), 200000000000, 6,
  'GVTT', 'test-treasury', '{}', 'seed-admin');
insert into workgroups(id, community_id, name) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Existing project'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Other project');
insert into tasks(id, workgroup_id, title) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Existing task'),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'Other task');
create temp table untouched as
  select to_jsonb(t) as row from tasks t union all select to_jsonb(w) from workgroups w;

-- 1. The sandbox seed on the head schema ------------------------------------------------
\ir ../seeds/signius_sandbox.sql
create temp view sandbox_groups as
  select id from workgroups where description like 'Sandbox test data (signius-test-tasks-v1)%';
create temp view sandbox_tasks as
  select t.*, c.marks_payable, c.workgroup_id as column_workgroup_id,
    (select count(*) from task_assignees a where a.task_id = t.id) as assignee_count
  from tasks t join board_columns c on c.id = t.column_id
  where t.workgroup_id in (select id from sandbox_groups);
-- The key counts signius_sandbox_seed.sql asserts, as one check to repeat after every run.
create function pg_temp.check_sandbox(step text) returns void language plpgsql as $$
begin
  if (select count(*) from sandbox_groups) <> 3
      or (select count(*) from board_columns where workgroup_id in (select id from sandbox_groups)) <> 15
      or (select count(*) from board_columns where marks_paid and workgroup_id in (select id from sandbox_groups)) <> 3 then
    raise exception '%: wrong sandbox workgroup or column counts', step;
  end if;
  if (select count(*) from sandbox_tasks) <> 49
      or (select count(*) from tasks where workgroup_id in (select id from sandbox_groups)) <> 49 then
    raise exception '%: wrong sandbox task count (%)', step, (select count(*) from sandbox_tasks);
  end if;
  -- Payable exactly when in the payable column (seeded state and the 0049 insert trigger agree).
  if exists (select 1 from sandbox_tasks t where t.source <> 'native' or t.column_workgroup_id <> t.workgroup_id
      or t.community_id <> '10000000-0000-0000-0000-000000000001' or t.title not like '[TEST %'
      or t.audited <> t.marks_payable
      or t.pay_state <> case when t.marks_payable then 'payable'::task_pay_state else 'none'::task_pay_state end
      or t.updated_at <> t.created_at or t.paid_tx_hash is not null or t.chain_number is not null) then
    raise exception '%: sandbox task routing or state is inconsistent', step;
  end if;
  if (select count(*) from sandbox_tasks where pay_state = 'payable') <> 12
      or (select count(*) from sandbox_tasks where archived_at is not null) <> 1
      or (select count(*) from sandbox_tasks where budget_month is not null) <> 5 then
    raise exception '%: wrong sandbox payable, archived or budget-month counts', step;
  end if;
  if (select count(*) from workgroups where id in (select id from sandbox_groups)
        and treasury_id = '20000000-0000-0000-0000-000000000001' and archived_at is null and has_activity) <> 2
      or not exists (select 1 from workgroups where name = '[TEST] Signius Content' and treasury_id is null and has_activity) then
    raise exception '%: wrong sandbox workgroup routing', step;
  end if;
  if (select sum((amounts->>'GVTT')::numeric) from sandbox_tasks where title not like '%Oversized reward%') <> 41500 then
    raise exception '%: wrong sandbox GVTT total', step;
  end if;
  if not exists (select 1 from community_assets where field_name = 'GVTT' and decimals = 6
      and unit = repeat('a',56) || encode(convert_to('Test Token','UTF8'),'hex')) then
    raise exception '%: token identity or precision lost', step;
  end if;
  -- One budget setup per sandbox workgroup, written through save_budget_setup by the owner.
  if (select count(*) from budget_setups where workgroup_id in (select id from sandbox_groups)) <> 3
      or (select count(distinct workgroup_id) from budget_setups where workgroup_id in (select id from sandbox_groups)) <> 3
      or (select count(*) from budget_changes where workgroup_id in (select id from sandbox_groups)) <> 7
      or exists (select 1 from budget_changes where workgroup_id in (select id from sandbox_groups)
        and (changed_by <> 'owner-wallet' or reason <> 'Seeded by signius_sandbox.sql'))
      or (select string_agg(w.name || '=' || st.revision, ',' order by w.name)
          from budget_setup_states st join workgroups w on w.id = st.workgroup_id where st.workgroup_id in (select id from sandbox_groups))
        <> '[TEST] Signius Community=1,[TEST] Signius Content=4,[TEST] Signius Product QA=2' then
    raise exception '%: sandbox budgets wrong', step;
  end if;
  if exists ((select row from untouched) except (select to_jsonb(t) from tasks t union all select to_jsonb(w) from workgroups w)) then
    raise exception '%: pre-existing tasks or workgroups changed', step;
  end if;
  if exists (select 1 from payouts) or exists (select 1 from transactions where kind <> 'mint') then
    raise exception '%: a seed created transactions or payouts', step;
  end if;
end $$;
select pg_temp.check_sandbox('sandbox, first run');
do $$ begin
  if (select count(*) from workgroups) <> 5 or (select count(*) from tasks) <> 51 then
    raise exception 'sandbox seed wrote outside its three workgroups';
  end if;
end $$;

-- A tester edits a card and adds a column; the rerun restores the sandbox exactly.
create temp table first_tasks as select to_jsonb(t) - 'number' as row from tasks t where workgroup_id in (select id from sandbox_groups);
create temp table first_assignees as select a.task_id, a.source, a.gh_login, a.wallet_address, a.position
  from task_assignees a where a.task_id in (select id from sandbox_tasks);
update tasks set title = 'Edited by a tester', amounts = '{"GVTT":"99"}'
  where id = (select id from sandbox_tasks where pay_state = 'payable' and archived_at is null and assignee_count = 1 order by id limit 1);
insert into board_columns(workgroup_id, name, position) select id, 'Extra', 9 from sandbox_groups limit 1;
\ir ../seeds/signius_sandbox.sql
select pg_temp.check_sandbox('sandbox, rerun');
do $$ begin
  if exists ((select row from first_tasks) except (select to_jsonb(t) - 'number' from tasks t where workgroup_id in (select id from sandbox_groups)))
      or exists ((select to_jsonb(t) - 'number' from tasks t where workgroup_id in (select id from sandbox_groups)) except (select row from first_tasks)) then
    raise exception 'sandbox rerun did not restore the tasks exactly';
  end if;
  if exists ((select * from first_assignees) except (select a.task_id, a.source, a.gh_login, a.wallet_address, a.position
        from task_assignees a where a.task_id in (select id from sandbox_tasks)))
      or exists ((select a.task_id, a.source, a.gh_login, a.wallet_address, a.position
        from task_assignees a where a.task_id in (select id from sandbox_tasks)) except (select * from first_assignees)) then
    raise exception 'sandbox rerun did not restore the assignees exactly';
  end if;
  -- Numbering is max()+1, so the deleted numbers 2..50 are handed out again.
  if (select max(number) from tasks where community_id = '10000000-0000-0000-0000-000000000001') <> 50
      or (select count(*) from tasks) <> 51 then
    raise exception 'task numbers or counts after the sandbox rerun are wrong';
  end if;
end $$;

-- 2. The live seed on the head schema, beside the sandbox --------------------------------
\ir ../seeds/signius_live.sql
create temp view runs_group as select id from workgroups where name = '[LIVE] Signius Payout Runs';
create temp view quarterly_group as select id from workgroups where name = '[LIVE] Signius Quarterly Runs';
create temp view live_group as select id from runs_group union all select id from quarterly_group;
create temp view live_tasks as
  select t.*, c.marks_payable, c.workgroup_id as column_workgroup_id,
    (select count(*) from task_assignees a where a.task_id = t.id) as assignee_count
  from tasks t join board_columns c on c.id = t.column_id
  where t.workgroup_id in (select id from live_group);
-- The key counts signius_live_seed.sql asserts, for `batches` runs of the seed.
create function pg_temp.check_live(step text, batches int) returns void language plpgsql as $$
begin
  if (select count(*) from runs_group) <> 1 or (select count(*) from quarterly_group) <> 1
      or (select count(*) from board_columns where workgroup_id in (select id from live_group)) <> 10
      or (select count(*) from board_columns where marks_paid and workgroup_id in (select id from live_group)) <> 2 then
    raise exception '%: wrong live workgroup or column counts', step;
  end if;
  -- The monthly workgroup pays from the mint treasury, the quarterly one from the second.
  if not exists (select 1 from workgroups where id in (select id from runs_group) and kind = 'native'
        and treasury_id = '20000000-0000-0000-0000-000000000001' and archived_at is null and has_activity)
      or not exists (select 1 from workgroups where id in (select id from quarterly_group) and kind = 'native'
        and treasury_id = '20000000-0000-0000-0000-000000000002' and archived_at is null and has_activity)
      or (select count(*) from workgroup_treasury_assignments where workgroup_id in (select id from live_group)
        and starts_on = date '1000-01-01' and created_by = 'owner-wallet') <> 2 then
    raise exception '%: live workgroup routing wrong', step;
  end if;
  if (select count(*) from live_tasks where workgroup_id in (select id from runs_group)) <> 15 * batches
      or (select count(*) from live_tasks where workgroup_id in (select id from quarterly_group)) <> 6 * batches
      or (select count(*) from tasks where workgroup_id in (select id from live_group)) <> 21 * batches then
    raise exception '%: wrong live task counts (%)', step, (select count(*) from live_tasks);
  end if;
  if exists (select 1 from live_tasks where not marks_payable or column_workgroup_id <> workgroup_id
      or pay_state <> 'payable' or not audited or archived_at is not null or source <> 'native'
      or title not like '[LIVE 2___-__-__ __:__] %' or body not like 'Live Signius payout batch %'
      or community_id <> '10000000-0000-0000-0000-000000000001' or created_at <> updated_at or chain_number is not null) then
    raise exception '%: live task shape wrong', step;
  end if;
  -- Per batch: every period but the current one is stamped; quarters as their first month.
  if (select count(*) from live_tasks where budget_month is null) <> 2 * batches
      or (select count(distinct budget_month) from live_tasks where workgroup_id in (select id from runs_group)) <> 5
      or (select count(distinct budget_month) from live_tasks where workgroup_id in (select id from quarterly_group)) <> 2
      or exists (select 1 from live_tasks where workgroup_id in (select id from quarterly_group)
        and extract(month from budget_month) not in (1, 4, 7, 10)) then
    raise exception '%: live batch periods wrong', step;
  end if;
  if (select count(*) from task_assignees where task_id in (select id from live_tasks)) <> 28 * batches
      or exists (select 1 from task_assignees where task_id in (select id from live_tasks)
        and (source <> 'manual' or wallet_address is null))
      or (select count(distinct wallet_address) from task_assignees where task_id in (select id from live_tasks)) <> 3 then
    raise exception '%: live batch assignee rows wrong', step;
  end if;
  if (select count(distinct substring(body from 'batch ([0-9]{8}-[0-9]{6}-[0-9]{3})')) from live_tasks) <> batches then
    raise exception '%: batches must carry distinct run ids', step;
  end if;
  -- One recurring budget each, seeded once by the owner through save_budget_setup.
  if (select count(*) from budget_setups where workgroup_id in (select id from live_group)) <> 2
      or not exists (select 1 from budget_setups s where s.workgroup_id in (select id from runs_group)
        and s.mode = 'recurring' and s.cadence = 'monthly' and jsonb_array_length(s.amounts) = 2
        and s.starts_on = (date_trunc('month', now() at time zone 'UTC') - interval '4 months')::date)
      or not exists (select 1 from budget_setups s where s.workgroup_id in (select id from quarterly_group)
        and s.mode = 'recurring' and s.cadence = 'quarterly' and jsonb_array_length(s.amounts) = 2
        and s.starts_on = (date_trunc('quarter', now() at time zone 'UTC') - interval '3 months')::date)
      or (select count(*) from budget_changes where workgroup_id in (select id from live_group)) <> 2
      or exists (select 1 from budget_changes where workgroup_id in (select id from live_group)
        and (changed_by <> 'owner-wallet' or reason <> 'Seeded by signius_live.sql'))
      or (select count(*) from budget_setup_states where workgroup_id in (select id from live_group) and revision = 1) <> 2 then
    raise exception '%: live workgroup budgets wrong', step;
  end if;
  if exists ((select row from untouched) except (select to_jsonb(t) from tasks t union all select to_jsonb(w) from workgroups w)) then
    raise exception '%: pre-existing tasks or workgroups changed', step;
  end if;
  if exists (select 1 from payouts) or exists (select 1 from transactions where kind <> 'mint') then
    raise exception '%: a seed created transactions or payouts', step;
  end if;
end $$;
select pg_temp.check_live('live, first run', 1);
-- The live seed left the sandbox alone.
select pg_temp.check_sandbox('sandbox, after the live seed');
do $$ begin
  if exists ((select row from first_tasks) except (select to_jsonb(t) - 'number' from tasks t where workgroup_id in (select id from sandbox_groups))) then
    raise exception 'the live seed changed sandbox tasks';
  end if;
  if (select count(*) from workgroups) <> 7 or (select count(*) from tasks) <> 72 then
    raise exception 'live seed wrote outside its two workgroups';
  end if;
end $$;

-- A second run appends one batch per workgroup and leaves the first alone.
create temp table first_batch as select to_jsonb(t) as row from tasks t where workgroup_id in (select id from live_group);
\ir ../seeds/signius_live.sql
select pg_temp.check_live('live, rerun', 2);
do $$ begin
  if exists ((select row from first_batch) except (select to_jsonb(t) from tasks t where workgroup_id in (select id from live_group))) then
    raise exception 'the live rerun changed the first batch';
  end if;
end $$;

-- 3. A sandbox reset beside live batches removes only the sandbox ------------------------
\ir ../seeds/signius_sandbox.sql
select pg_temp.check_sandbox('sandbox, reset beside live batches');
select pg_temp.check_live('live, after the sandbox reset', 2);
do $$ begin
  if exists ((select row from first_batch) except (select to_jsonb(t) from tasks t where workgroup_id in (select id from live_group))) then
    raise exception 'the sandbox reset changed live tasks';
  end if;
  if (select count(*) from tasks) <> 93 or (select count(distinct number) from tasks
      where community_id = '10000000-0000-0000-0000-000000000001') <> 92 then
    raise exception 'task counts or numbers after all runs are wrong';
  end if;
end $$;

-- 4. Reruns with every governance kind on (0055-0056) ------------------------------------
-- The budgets exist already, so neither seed saves one and budget consent has
-- nothing to refuse; the seeds' workgroups and tasks are direct database
-- writes, which the workgroup and task kinds do not close.
insert into governance_settings(community_id, kind, enabled, proposers, electorate, method, quorum_pct,
    threshold_pct, discussion_hours, voting_hours, updated_by)
  select '10000000-0000-0000-0000-000000000001', k, true, 'members', 'members', 'majority', 20, 50, 48, 120, 'owner-wallet'
  from unnest(array['budget', 'workgroup', 'task', 'decision']) k;
\ir ../seeds/signius_live.sql
select pg_temp.check_live('live, governance on', 3);
\ir ../seeds/signius_sandbox.sql
select pg_temp.check_sandbox('sandbox, governance on');
select pg_temp.check_live('live, after the sandbox reset with governance on', 3);

-- 5. A workgroup with no budget yet, budget kind on --------------------------------------
-- Budgets change only by proposal there, so the seeds add their tasks and
-- leave the budget alone instead of being refused by guard_budget_consent.
delete from budget_changes where workgroup_id in (select id from sandbox_groups union select id from live_group);
delete from budget_setups where workgroup_id in (select id from sandbox_groups union select id from live_group);
delete from budget_setup_states where workgroup_id in (select id from sandbox_groups union select id from live_group);
\ir ../seeds/signius_live.sql
\ir ../seeds/signius_sandbox.sql
do $$ begin
  if exists (select 1 from budget_setups where workgroup_id in (select id from sandbox_groups union select id from live_group))
      or exists (select 1 from budget_changes where workgroup_id in (select id from sandbox_groups union select id from live_group)) then
    raise exception 'a seed wrote a budget while budgets change by proposal';
  end if;
  if (select count(*) from sandbox_tasks) <> 49
      or (select count(*) from tasks where workgroup_id in (select id from live_group)) <> 4 * 21 then
    raise exception 'the seeds did not add their tasks with budget consent on';
  end if;
end $$;
-- Consent off again: the next run sets the budgets up.
update governance_settings set enabled = false where kind = 'budget';
\ir ../seeds/signius_live.sql
\ir ../seeds/signius_sandbox.sql
select pg_temp.check_sandbox('sandbox, consent off again');
select pg_temp.check_live('live, consent off again', 5);

rollback;
\echo Signius seeds on the head schema passed (all changes rolled back).
