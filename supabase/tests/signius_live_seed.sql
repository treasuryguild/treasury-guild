-- Run with psql -f against an EMPTY disposable PostgreSQL database.
-- Everything, including the schema and roles, is rolled back.
\set ON_ERROR_STOP on
begin;
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
grant usage on schema public, auth to anon, authenticated, service_role;
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

insert into contributors(wallet_address) values
  ('seed-admin'), ('owner-wallet'), ('admin-wallet-1'), ('admin-wallet-2');
insert into communities(id, slug, name, created_by) values
  ('10000000-0000-0000-0000-000000000001', 'signius', 'Signius', 'seed-admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000001', 'owner-wallet', 'owner'),
  ('10000000-0000-0000-0000-000000000001', 'admin-wallet-1', 'admin'),
  ('10000000-0000-0000-0000-000000000001', 'admin-wallet-2', 'admin');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Test treasury', 0, 1, 'test-treasury', '00');
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
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Existing project');
insert into tasks(id, workgroup_id, title) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Existing task');
create temp table untouched as
  select to_jsonb(t) as row from tasks t union all select to_jsonb(w) from workgroups w;

-- With a single treasury both live workgroups start out on the mint treasury.
savepoint single_treasury;
\ir ../seeds/signius_live.sql
do $$ begin
  if (select count(*) from workgroups where name like '[LIVE] Signius %'
      and treasury_id = '20000000-0000-0000-0000-000000000001') <> 2
    or (select count(*) from workgroup_treasury_assignments where treasury_id = '20000000-0000-0000-0000-000000000001') <> 2 then
    raise exception 'Single-treasury fallback wrong';
  end if;
end $$;
rollback to single_treasury;

-- A monthly workgroup already rerouted off the mint treasury: the quarterly
-- one is created on the wallet the monthly one does not use.
savepoint runs_rerouted;
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Quarterly treasury', 0, 1, 'quarterly-treasury', '00');
\ir ../seeds/signius_live.sql
update workgroups set treasury_id = '20000000-0000-0000-0000-000000000002' where name = '[LIVE] Signius Payout Runs';
-- Only the workgroup row goes (triggers off: the delete guard would refuse);
-- its leftovers are harmless here and everything is rolled back.
set local session_replication_role = replica;
delete from workgroups where name = '[LIVE] Signius Quarterly Runs';
set local session_replication_role = origin;
\ir ../seeds/signius_live.sql
do $$ begin
  if (select treasury_id from workgroups where name = '[LIVE] Signius Quarterly Runs') <> '20000000-0000-0000-0000-000000000001'
    or (select treasury_id from workgroups where name = '[LIVE] Signius Payout Runs') <> '20000000-0000-0000-0000-000000000002' then
    raise exception 'Quarterly workgroup must avoid the monthly workgroup''s treasury';
  end if;
end $$;
rollback to runs_rerouted;

-- The oldest preprod treasury that did not mint GVTT takes the quarterly workgroup.
insert into treasuries(id, community_id, name, network, required, address, script_cbor, created_at) values
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Quarterly treasury', 0, 1, 'quarterly-treasury', '00', now() - interval '2 days'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'Newer treasury', 0, 1, 'newer-treasury', '00', now() - interval '1 day');

\ir ../seeds/signius_live.sql
create temp view runs_group as
  select id from workgroups where name = '[LIVE] Signius Payout Runs';
create temp view quarterly_group as
  select id from workgroups where name = '[LIVE] Signius Quarterly Runs';
create temp view live_group as
  select id from runs_group union all select id from quarterly_group;
create temp view live_tasks as
  select t.*, c.marks_payable, c.workgroup_id as column_workgroup_id,
    (select count(*) from task_assignees a where a.task_id = t.id) as assignee_count
  from tasks t join board_columns c on c.id = t.column_id
  where t.workgroup_id in (select id from live_group);
create temp view runs_tasks as
  select * from live_tasks where workgroup_id in (select id from runs_group);
create temp view quarterly_tasks as
  select * from live_tasks where workgroup_id in (select id from quarterly_group);

do $$ begin
  if (select count(*) from runs_group) <> 1 or (select count(*) from quarterly_group) <> 1
    or (select count(*) from workgroups) <> 3
    or (select count(*) from board_columns) <> 10
    or (select count(*) from board_columns where marks_paid) <> 2 then
    raise exception 'Wrong workgroup or column counts';
  end if;
  -- The monthly workgroup pays from the mint treasury, the quarterly one from the second.
  if not exists (select 1 from workgroups where id in (select id from runs_group) and kind = 'native'
      and treasury_id = '20000000-0000-0000-0000-000000000001' and archived_at is null and has_activity)
    or not exists (select 1 from workgroups where id in (select id from quarterly_group) and kind = 'native'
      and treasury_id = '20000000-0000-0000-0000-000000000002' and archived_at is null and has_activity) then
    raise exception 'Live workgroup routing wrong';
  end if;
  -- Each cached routing is backed by one timeline row (migration 0035), written by the owner.
  if (select count(*) from workgroup_treasury_assignments where workgroup_id in (select id from live_group)) <> 2
    or not exists (select 1 from workgroup_treasury_assignments where workgroup_id in (select id from runs_group)
      and treasury_id = '20000000-0000-0000-0000-000000000001' and starts_on = date '1000-01-01'
      and created_by = 'owner-wallet')
    or not exists (select 1 from workgroup_treasury_assignments where workgroup_id in (select id from quarterly_group)
      and treasury_id = '20000000-0000-0000-0000-000000000002' and starts_on = date '1000-01-01'
      and created_by = 'owner-wallet') then
    raise exception 'Live workgroup routing timeline wrong';
  end if;
  -- One batch = three scenarios for each of the last five months, plus three
  -- for each of the last two quarters.
  if (select count(*) from runs_tasks) <> 15 or (select count(*) from quarterly_tasks) <> 6
    or (select count(*) from tasks) <> 22 then
    raise exception 'Wrong task counts';
  end if;
  -- Every seeded id must pass the API's RFC 4122 check (version 4, variant 8-b).
  if exists (select id from (select id from live_group union all select id from live_tasks
      union all select id from board_columns) x
    where id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
    raise exception 'Seeded ids are not RFC 4122 v4 shaped';
  end if;
  if exists (select 1 from live_tasks where not marks_payable or column_workgroup_id <> workgroup_id
    or pay_state <> 'payable' or not audited or archived_at is not null or source <> 'native'
    or title not like '[LIVE 2___-__-__ __:__] %' or body not like 'Live Signius payout batch %'
    or community_id <> '10000000-0000-0000-0000-000000000001' or created_at <> updated_at) then
    raise exception 'Live task shape wrong';
  end if;
  -- Five consecutive budget months ending in the current one; the current
  -- month's ADA reward is the only task without a budget month.
  if (select count(distinct budget_month) from runs_tasks where budget_month is not null) <> 5
    or (select min(budget_month) from runs_tasks) <> (date_trunc('month', now() at time zone 'UTC') - interval '4 months')::date
    or (select max(budget_month) from runs_tasks) <> date_trunc('month', now() at time zone 'UTC')::date
    or exists (select 1 from runs_tasks where budget_month is not null
      and title not like '[LIVE %] ' || to_char(budget_month, 'YYYY-MM') || ' %') then
    raise exception 'Live batch months wrong';
  end if;
  if (select count(*) from runs_tasks where amounts = '{"GVTT":"1"}'::jsonb and bounty_lovelace is null
      and assignee_count = 1 and budget_month is not null) <> 5
    or (select count(distinct budget_month) from runs_tasks where amounts = '{"GVTT":"1"}'::jsonb) <> 5
    or (select count(*) from runs_tasks where amounts = '{"GVTT":"2.5","ADA":"1.5"}'::jsonb and bounty_lovelace = 1500000
      and assignee_count = 2 and budget_month is not null) <> 5
    or (select count(distinct budget_month) from runs_tasks where amounts = '{"GVTT":"2.5","ADA":"1.5"}'::jsonb) <> 5
    or (select count(*) from runs_tasks where amounts = '{"ADA":"0.5"}'::jsonb and bounty_lovelace = 500000
      and assignee_count = 1 and budget_month is not null) <> 4
    or (select count(*) from runs_tasks where amounts = '{"ADA":"0.5"}'::jsonb and bounty_lovelace = 500000
      and assignee_count = 1 and budget_month is null
      and title like '[LIVE %] ' || to_char(now() at time zone 'UTC', 'YYYY-MM') || ' %') <> 1 then
    raise exception 'Live batch amounts or assignees wrong';
  end if;
  -- Two consecutive quarters ending in the current one, stored as their first
  -- month; the current quarter's ADA reward is the only task without one.
  if (select count(distinct budget_month) from quarterly_tasks where budget_month is not null) <> 2
    or (select min(budget_month) from quarterly_tasks) <> (date_trunc('quarter', now() at time zone 'UTC') - interval '3 months')::date
    or (select max(budget_month) from quarterly_tasks) <> date_trunc('quarter', now() at time zone 'UTC')::date
    or exists (select 1 from quarterly_tasks where extract(month from budget_month) not in (1, 4, 7, 10))
    or exists (select 1 from quarterly_tasks where title !~ '^\[LIVE [^]]+\] [0-9]{4}-Q[1-4] ')
    or exists (select 1 from quarterly_tasks where budget_month is not null
      and title not like '[LIVE %] ' || to_char(budget_month, 'YYYY-"Q"Q') || ' %') then
    raise exception 'Live batch quarters wrong';
  end if;
  if (select count(*) from quarterly_tasks where amounts = '{"GVTT":"1"}'::jsonb and assignee_count = 1
      and budget_month is not null) <> 2
    or (select count(*) from quarterly_tasks where amounts = '{"GVTT":"2.5","ADA":"1.5"}'::jsonb
      and bounty_lovelace = 1500000 and assignee_count = 2 and budget_month is not null) <> 2
    or (select count(*) from quarterly_tasks where amounts = '{"ADA":"0.5"}'::jsonb and bounty_lovelace = 500000
      and assignee_count = 1 and budget_month is not null) <> 1
    or (select count(*) from quarterly_tasks where amounts = '{"ADA":"0.5"}'::jsonb and budget_month is null
      and title like '[LIVE %] ' || to_char(now() at time zone 'UTC', 'YYYY-"Q"Q') || ' %') <> 1 then
    raise exception 'Quarterly batch amounts or assignees wrong';
  end if;
  if (select count(*) from task_assignees) <> 28
    or exists (select 1 from task_assignees where source <> 'manual' or wallet_address is null)
    or (select count(distinct wallet_address) from task_assignees) <> 3 then
    raise exception 'Live batch assignee rows wrong';
  end if;
  if not exists (select 1 from community_assets where field_name = 'GVTT' and decimals = 6
    and unit = repeat('a',56) || encode(convert_to('Test Token','UTF8'),'hex')) then
    raise exception 'Token identity or precision lost';
  end if;
  if (select count(*) from transactions) <> 1 or exists (select 1 from payouts) then
    raise exception 'Seed must not create transactions or payouts';
  end if;
  if exists ((select row from untouched) except (select to_jsonb(t) from tasks t union all select to_jsonb(w) from workgroups w)) then
    raise exception 'Pre-existing tasks or workgroups changed';
  end if;
  -- One recurring budget each, from the earliest seeded period, written by the owner through save_budget_setup.
  if not exists (select 1 from budget_setups s where s.workgroup_id in (select id from quarterly_group)
      and s.mode = 'recurring' and s.cadence = 'quarterly'
      and s.starts_on = (date_trunc('quarter', now() at time zone 'UTC') - interval '3 months')::date
      and jsonb_array_length(s.amounts) = 2) then
    raise exception 'Quarterly workgroup budget wrong';
  end if;
  if (select count(*) from budget_setups) <> 2
    or not exists (select 1 from budget_setups s where s.workgroup_id in (select id from runs_group)
      and s.mode = 'recurring' and s.cadence = 'monthly'
      and s.starts_on = (date_trunc('month', now() at time zone 'UTC') - interval '4 months')::date
      and jsonb_array_length(s.amounts) = 2
      and s.amounts @> jsonb_build_array(
        jsonb_build_object('unit', repeat('a',56) || encode(convert_to('Test Token','UTF8'),'hex'), 'amount', '25000000', 'asset_label', 'GVTT', 'decimals', 6),
        jsonb_build_object('unit', 'lovelace', 'amount', '10000000', 'asset_label', 'ADA', 'decimals', 6)))
    or (select count(*) from budget_changes) <> 2
    or exists (select 1 from budget_changes where changed_by <> 'owner-wallet' or reason <> 'Seeded by signius_live.sql')
    or (select count(*) from budget_setup_states where workgroup_id in (select id from live_group) and revision = 1) <> 2 then
    raise exception 'Live workgroup budget wrong';
  end if;
end $$;

-- The first batch gets paid for real; the next run must add a fresh batch and leave it alone.
insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state, submitted_at) values
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'payout', '00', 'paid-hash', 'seed-admin', 2, now());
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount, status)
  select '30000000-0000-0000-0000-000000000002', t.id, a.wallet_address, 'lovelace', 1, 'confirmed'
  from live_tasks t join task_assignees a on a.task_id = t.id;
update tasks set pay_state = 'paid', paid_tx_hash = 'paid-hash', budget_month = coalesce(budget_month, '2026-09-01')
  where workgroup_id in (select id from runs_group);
update tasks set pay_state = 'paid', paid_tx_hash = 'paid-hash', budget_month = coalesce(budget_month, '2026-07-01')
  where workgroup_id in (select id from quarterly_group);
create temp table first_batch as select to_jsonb(t) as row from tasks t where workgroup_id in (select id from live_group);
create temp table first_assignees as select task_id, source, gh_login, wallet_address, position from task_assignees;
create temp table first_columns as select * from board_columns;

\ir ../seeds/signius_live.sql
do $$ begin
  if (select count(*) from live_tasks) <> 42 or (select count(*) from tasks where pay_state = 'payable') <> 21
    or (select count(*) from tasks where pay_state = 'paid') <> 21
    or (select count(*) from quarterly_tasks) <> 12 then
    raise exception 'Second run did not add exactly one new batch per workgroup';
  end if;
  if exists ((select row from first_batch) except (select to_jsonb(t) from tasks t where workgroup_id in (select id from live_group))) then
    raise exception 'Second run changed the paid batch';
  end if;
  if exists ((select * from first_assignees) except (select task_id, source, gh_login, wallet_address, position from task_assignees))
    or (select count(*) from task_assignees) <> 56 then
    raise exception 'Second run changed or lost assignees';
  end if;
  if exists ((select * from first_columns) except (select * from board_columns))
    or (select count(*) from board_columns) <> 10 then
    raise exception 'Second run changed the board columns';
  end if;
  if (select count(*) from transactions) <> 2 or (select count(*) from payouts) <> 28 then
    raise exception 'Second run touched payment history';
  end if;
  -- Distinct batch ids: the new tasks must reference a different run id in their bodies.
  if (select count(distinct substring(body from 'batch ([0-9]{8}-[0-9]{6}-[0-9]{3})')) from live_tasks) <> 2 then
    raise exception 'Batches must carry distinct run ids';
  end if;
  if (select count(*) from budget_setups) <> 2 or (select count(*) from budget_changes) <> 2
    or (select count(*) from budget_setup_states where workgroup_id in (select id from live_group) and revision = 1) <> 2 then
    raise exception 'Second run must leave the budgets alone';
  end if;
end $$;

-- Each expected rejection is isolated; unexpected success fails the test. One
-- live workgroup out of shape stops the whole run (the seed is one statement).
savepoint archived_group;
update tasks set pay_state = 'paid' where workgroup_id in (select id from runs_group) and pay_state = 'payable';
update workgroups set archived_at = now(), archived_by = 'owner-wallet' where id in (select id from runs_group);
\set ON_ERROR_STOP off
\ir ../seeds/signius_live.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to archived_group;

-- (Routing to another community's treasury is already impossible: the
-- workgroups_treasury_same_community foreign key rejects it before the seed's
-- own guard can.)
savepoint not_native;
update workgroups set kind = 'github' where id in (select id from quarterly_group);
\set ON_ERROR_STOP off
\ir ../seeds/signius_live.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to not_native;

-- Rerouting in the app to another Signius preprod wallet, or to "any wallet",
-- is respected: the seed keeps adding batches and neither touches the routing
-- nor the timeline. The pending count follows the wallet that will pay.
savepoint rerouted_group;
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Second treasury', 0, 1, 'second-treasury', '00');
insert into workgroup_treasury_assignments(workgroup_id, treasury_id, starts_on, created_by)
  select id, '20000000-0000-0000-0000-000000000003', date_trunc('month', now() at time zone 'UTC')::date, 'owner-wallet' from runs_group;
update workgroups set treasury_id = '20000000-0000-0000-0000-000000000003' where id in (select id from runs_group);
insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state) values
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'payout', '00', 'seed-admin', 0);
\ir ../seeds/signius_live.sql
do $$ begin
  if (select count(*) from live_tasks) <> 63
    or (select treasury_id from workgroups where id in (select id from runs_group)) <> '20000000-0000-0000-0000-000000000003'
    or (select count(*) from workgroup_treasury_assignments where workgroup_id in (select id from runs_group)) <> 2
    or (current_setting('seed.summary', true)::jsonb #>> '{workgroups,runs,routedTreasury}') <> '20000000-0000-0000-0000-000000000003'
    or (current_setting('seed.summary', true)::jsonb ->> 'mintTreasury') <> '20000000-0000-0000-0000-000000000001'
    or (current_setting('seed.summary', true)::jsonb #>> '{workgroups,runs,pendingTreasuryTransactions}') <> '0'
    or (current_setting('seed.summary', true)::jsonb #>> '{workgroups,quarterly,routedTreasury}') <> '20000000-0000-0000-0000-000000000002'
    or (current_setting('seed.summary', true)::jsonb #>> '{workgroups,quarterly,insertedTasks}') <> '6'
    or (current_setting('seed.summary', true)::jsonb ->> 'insertedTasks') <> '21' then
    raise exception 'Rerouted workgroup handling wrong';
  end if;
end $$;
update workgroups set treasury_id = null where id in (select id from runs_group);
\ir ../seeds/signius_live.sql
do $$ begin
  if (select count(*) from live_tasks) <> 84
    or (select treasury_id from workgroups where id in (select id from runs_group)) is not null
    or (current_setting('seed.summary', true)::jsonb #> '{workgroups,runs,routedTreasury}') <> 'null'::jsonb
    or (current_setting('seed.summary', true)::jsonb #>> '{workgroups,runs,pendingTreasuryTransactions}') <> '1'
    or (current_setting('seed.summary', true)::jsonb #>> '{workgroups,quarterly,pendingTreasuryTransactions}') <> '0' then
    raise exception 'Unrouted workgroup handling wrong';
  end if;
end $$;
rollback to rerouted_group;

savepoint no_members;
delete from community_members where community_id = '10000000-0000-0000-0000-000000000001';
\set ON_ERROR_STOP off
\ir ../seeds/signius_live.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to no_members;

savepoint mainnet;
update communities set network = 1 where slug = 'signius';
\set ON_ERROR_STOP off
\ir ../seeds/signius_live.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to mainnet;

savepoint missing_mint;
update transactions set state = 3 where kind = 'mint';
\set ON_ERROR_STOP off
\ir ../seeds/signius_live.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to missing_mint;

-- A one-member community still gets a batch: the two-assignee task collapses to one wallet.
savepoint one_member;
delete from community_members where community_id = '10000000-0000-0000-0000-000000000001' and role <> 'owner';
\ir ../seeds/signius_live.sql
do $$ begin
  if (select count(*) from live_tasks) <> 63
    or exists (select 1 from task_assignees a join live_tasks t on t.id = a.task_id
      where t.created_at = (select max(created_at) from live_tasks) and a.wallet_address <> 'owner-wallet')
    or exists (select 1 from live_tasks where created_at = (select max(created_at) from live_tasks) and assignee_count <> 1) then
    raise exception 'Single-member fallback wrong';
  end if;
end $$;
rollback to one_member;

rollback;
\echo Signius live seed tests passed (all changes rolled back).
