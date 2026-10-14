-- Migration 0036: manual payments and treasury-owned budgets. Run with psql -f
-- against an EMPTY disposable PostgreSQL database; everything is rolled back.
\set ON_ERROR_STOP on
begin;
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
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

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

insert into contributors(wallet_address) values ('admin'), ('member'), ('outsider');
insert into communities(id, slug, name, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 'admin'),
  ('10000000-0000-0000-0000-000000000002', 'other', 'Other', 'outsider');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'admin'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member'),
  ('10000000-0000-0000-0000-000000000002', 'outsider', 'owner');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Dev', 0, 1, 'addr_dev', '00'),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'Elsewhere', 0, 1, 'addr_other', '00');
insert into workgroups(id, community_id, name) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Group 1');
-- A workgroup budget from before the migration keeps its state and setup.
insert into budget_setup_states(workgroup_id, revision) values ('20000000-0000-0000-0000-000000000001', 3);
insert into budget_setups(workgroup_id, starts_on, mode, cadence, amounts) values
  ('20000000-0000-0000-0000-000000000001', '2000-01-01', 'recurring', 'monthly',
   '[{"unit":"lovelace","amount":"100","asset_label":"ADA","decimals":6}]');
insert into budget_changes(workgroup_id, changed_by, effective_on, before_value, after_value) values
  ('20000000-0000-0000-0000-000000000001', 'admin', '2000-01-01', '{}', '{}');

\ir ../migrations/0036_payments_treasury_budgets.sql

set local role service_role;
do $$
declare
  guild uuid := '10000000-0000-0000-0000-000000000000';
  wg uuid := '20000000-0000-0000-0000-000000000001';
  main uuid := '40000000-0000-0000-0000-000000000001';
  dev uuid := '40000000-0000-0000-0000-000000000002';
  a jsonb := '[{"unit":"lovelace","amount":"200","asset_label":"ADA","decimals":6}]';
  this_month date := date_trunc('month', now() at time zone 'UTC')::date;
  next_quarter date := (date_trunc('quarter', now() at time zone 'UTC') + interval '3 months')::date;
  r integer;
  ws jsonb;
  tx uuid;
begin
  -- Existing rows carry the workgroup owner key; the migrated state keeps its revision.
  if (select owner_key from budget_setup_states where workgroup_id = wg) <> 'w:' || wg::text
    or (select revision from budget_setup_states where workgroup_id = wg) <> 3
    or (select owner_key from budget_setups where workgroup_id = wg) <> 'w:' || wg::text
    or (select owner_key from budget_changes where workgroup_id = wg) <> 'w:' || wg::text then
    raise exception 'Existing budget rows were not keyed by owner';
  end if;
  -- Exactly one owner.
  perform pg_temp.reject(format('insert into budget_setups(workgroup_id, treasury_id, starts_on, mode, cadence) values (%L, %L, ''2030-01-01'', ''recurring'', ''monthly'')', wg, main), '23514');
  perform pg_temp.reject('insert into budget_setups(starts_on, mode, cadence) values (''2030-01-01'', ''recurring'', ''monthly'')', '23514');
  perform pg_temp.reject('insert into budget_setup_states(revision) values (0)', '23514');
  perform pg_temp.reject(format('insert into budget_changes(workgroup_id, treasury_id, changed_by, effective_on, before_value, after_value) values (%L, %L, ''admin'', ''2030-01-01'', ''{}'', ''{}'')', wg, main), '23514');
  -- Existing signature still works (positional call, no treasury).
  r := save_budget_setup(wg, 3, 'recurring', 'monthly', '2030-01-01', a, 'admin');
  if r <> 4 then raise exception 'Workgroup save broke: revision %', r; end if;
  perform pg_temp.reject(format('select save_budget_setup(%L, 0, ''recurring'', ''monthly'', ''2030-01-01'', %L, ''admin'', false, null, %L)', wg, a, main), '23514');
  perform pg_temp.reject(format('select save_budget_setup(null, 0, ''recurring'', ''monthly'', ''2030-01-01'', %L, ''admin'', false, null, %L)', a, '40000000-0000-0000-0000-000000000009'), '23514');

  -- A treasury gets its own state, setup, change and revision.
  r := save_budget_setup(null, 0, 'recurring', 'monthly', this_month, a, 'admin', false, null, main);
  if r <> 1
    or not exists (select 1 from budget_setup_states where treasury_id = main and workgroup_id is null and owner_key = 't:' || main::text and revision = 1)
    or not exists (select 1 from budget_setups where treasury_id = main and workgroup_id is null and starts_on = this_month and mode = 'recurring')
    or not exists (select 1 from budget_changes where treasury_id = main and workgroup_id is null and changed_by = 'admin') then
    raise exception 'Treasury budget setup not recorded';
  end if;
  perform pg_temp.reject(format('select save_budget_setup(null, 0, ''recurring'', ''monthly'', %L, %L, ''admin'', false, null, %L)', next_quarter, a, main), '40001');
  -- The same rules apply: a mode switch needs confirmation and a quarter boundary.
  perform pg_temp.reject(format('select save_budget_setup(null, 1, ''quarterly'', ''quarterly'', %L, %L, ''admin'', false, null, %L)', next_quarter, a, main), '23514');
  perform pg_temp.reject(format('select save_budget_setup(null, 1, ''quarterly'', ''quarterly'', %L, %L, ''admin'', true, null, %L)', (next_quarter + interval '1 month')::date, a, main), '23514');
  r := save_budget_setup(null, 1, 'quarterly', 'quarterly', next_quarter, a, 'admin', true, null, main);
  if r <> 2 or (select count(*) from budget_plans p join budget_setups s on s.id = p.setup_id where s.treasury_id = main) <> 1 then
    raise exception 'Treasury quarterly plan not saved';
  end if;
  -- Another treasury's timeline is independent; the workgroup's is untouched.
  r := save_budget_setup(null, 0, 'recurring', 'monthly', '2030-01-01', a, 'admin', false, null, dev);
  if r <> 1 or (select count(*) from budget_setups where workgroup_id = wg) <> 2
    or (select revision from budget_setup_states where workgroup_id = wg) <> 4 then
    raise exception 'Owners leaked into each other';
  end if;

  -- The workspace lists workgroups first, then treasuries, each with its owner.
  ws := budget_setup_workspace(guild);
  if jsonb_array_length(ws) <> 3
    or ws->0->>'ownerType' <> 'workgroup' or (ws->0->>'ownerId')::uuid <> wg or (ws->0->>'workgroupId')::uuid <> wg
    or ws->0->>'treasuryId' is not null or ws->0->>'workgroupKind' <> 'native' or ws->0->>'ownerName' <> 'Group 1'
    or ws->1->>'ownerType' <> 'treasury' or (ws->1->>'ownerId')::uuid <> dev or (ws->1->>'treasuryId')::uuid <> dev
    or ws->1->>'workgroupId' is not null or ws->1->>'workgroupKind' is not null or ws->1->>'ownerName' <> 'Dev'
    or ws->2->>'ownerName' <> 'Main' or (ws->2->>'revision')::int <> 2
    or jsonb_array_length(ws->2->'timeline') <> 2 or jsonb_array_length(ws->2->'plans') <> 1
    or jsonb_array_length(ws->2->'history') <> 2 or jsonb_array_length(ws->2->'legacy') <> 0 then
    raise exception 'Workspace owners wrong: %', ws;
  end if;
  if jsonb_array_length(budget_setup_workspace('10000000-0000-0000-0000-000000000002')) <> 1 then
    raise exception 'Workspace must list only the community''s treasuries';
  end if;

  -- Budget reset still works for a workgroup (the states upsert keys on the owner).
  r := reset_workgroup_budgets(wg, 4, 'admin', 'Group 1', 'Start over');
  if r <> 5 or exists (select 1 from budget_setups where workgroup_id = wg)
    or (select count(*) from budget_setups where treasury_id = main) <> 2 then
    raise exception 'Workgroup reset broke or touched treasury budgets';
  end if;

  -- Payment rows: a fourth transaction kind; spend is stamped, transfers are not.
  insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state) values
    ('50000000-0000-0000-0000-000000000001', main, 'payment', '00', 'admin', 0) returning id into tx;
  perform pg_temp.reject('insert into transactions(treasury_id, kind, tx_cbor, created_by) values (''40000000-0000-0000-0000-000000000001'', ''refund'', ''00'', ''admin'')', '23514');
  insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, label, unit, amount, budget_month) values
    (tx, guild, main, 'addr_contractor', null, 'lovelace', 5000000, date_trunc('month', now() at time zone 'UTC')::date),
    (tx, guild, main, 'member', 'Member', 'lovelace', 1000000, date_trunc('month', now() at time zone 'UTC')::date);
  insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, recipient_treasury_id, label, unit, amount) values
    (tx, guild, main, 'addr_dev', dev, 'Dev', 'lovelace', 2000000);
  perform pg_temp.reject(format('insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, unit, amount) values (%L, %L, %L, ''addr_x'', ''lovelace'', 1)', tx, guild, main), '23514');
  perform pg_temp.reject(format('insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, recipient_treasury_id, unit, amount, budget_month) values (%L, %L, %L, ''addr_dev'', %L, ''lovelace'', 1, ''2030-01-01'')', tx, guild, main, dev), '23514');
  perform pg_temp.reject(format('insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, unit, amount, budget_month) values (%L, %L, %L, ''addr_y'', ''lovelace'', 1, ''2030-01-15'')', tx, guild, main), '23514');
  perform pg_temp.reject(format('insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, unit, amount, budget_month) values (%L, %L, %L, ''addr_z'', ''lovelace'', 0, ''2030-01-01'')', tx, guild, main), '23514');
  perform pg_temp.reject(format('insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, unit, amount, budget_month) values (%L, %L, %L, ''member'', ''lovelace'', 1, ''2030-01-01'')', tx, guild, main), '23505');
  if (select count(*) from payments where transaction_id = tx) <> 3 then raise exception 'Payment rows missing'; end if;
  delete from transactions where id = tx;
  if exists (select 1 from payments) then raise exception 'Payments must cascade with their transaction'; end if;
end $$;
reset role;

-- Members read their community's treasury budgets and payments, nobody else's.
select set_config('request.jwt.claims','{"wallet":"member"}',true);
set local role authenticated;
do $$
begin
  if (select count(*) from budget_setups where treasury_id is not null) <> 3
    or (select count(*) from budget_setup_states where treasury_id is not null) <> 2
    or (select count(*) from budget_changes where treasury_id is not null) <> 3
    or (select count(*) from budget_plans) <> 1 then
    raise exception 'Members must read treasury budgets of their community';
  end if;
  perform pg_temp.reject('insert into budget_setups(treasury_id, starts_on, mode, cadence) values (''40000000-0000-0000-0000-000000000001'', ''2031-01-01'', ''recurring'', ''monthly'')', '42501');
  perform pg_temp.reject('select save_budget_setup(null, 2, ''recurring'', ''monthly'', ''2031-01-01'', ''[]'', ''member'', false, null, ''40000000-0000-0000-0000-000000000001'')', '42501');
  perform pg_temp.reject('insert into payments(transaction_id, community_id, treasury_id, recipient_wallet, unit, amount, budget_month) values (gen_random_uuid(), ''10000000-0000-0000-0000-000000000000'', ''40000000-0000-0000-0000-000000000001'', ''x'', ''lovelace'', 1, ''2030-01-01'')', '42501');
end $$;
reset role;
select set_config('request.jwt.claims','{"wallet":"outsider"}',true);
set local role authenticated;
do $$
begin
  if exists (select 1 from budget_setups) or exists (select 1 from budget_setup_states)
    or exists (select 1 from budget_changes) or exists (select 1 from budget_plans) or exists (select 1 from payments) then
    raise exception 'Budgets leaked to another community';
  end if;
end $$;
reset role;

rollback;
\echo Treasury budgets and payments migration checks passed (all changes rolled back).
