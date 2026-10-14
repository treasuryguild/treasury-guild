-- Migration 0045: chain import (chain numbers, import_chain_tx, workgroup
-- aliases). Run with psql -f against an EMPTY disposable PostgreSQL database;
-- everything is rolled back.
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

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

insert into contributors(wallet_address) values ('admin'), ('alice');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Dev', 0, 1, 'addr_dev', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Runs', 'native'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Old', 'native');
insert into board_columns(id, workgroup_id, name, position, marks_payable, marks_paid) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Audited', 0, true, false),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Paid', 1, false, true);
-- Task #1 is payable and assigned to alice; task #2 was paid by something else.
insert into tasks(id, workgroup_id, source, title, amounts, bounty_lovelace, pay_state, audited, column_id) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'native', 'Write docs', '{"ADA":"5"}', 5000000, 'payable', true, '50000000-0000-0000-0000-000000000001');
insert into tasks(id, workgroup_id, source, title, amounts, bounty_lovelace, pay_state, audited) values
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'native', 'Other work', '{"ADA":"1"}', 1000000, 'paid', true);
insert into task_assignees(task_id, source, wallet_address, position) values
  ('30000000-0000-0000-0000-000000000001', 'manual', 'alice', 0);
update workgroups set archived_at = now(), archived_by = 'admin' where id = '20000000-0000-0000-0000-000000000002';

insert into external_txs(tx_hash, treasury_id, block_height, block_time, fee_lovelace, amount_lovelace, to_addresses, payout_meta) values
  ('payout1', '40000000-0000-0000-0000-000000000001', 1, '2026-08-10T12:00:00Z', 200000, 12000000, '{alice,bob}', '{"p":[]}'),
  ('payout2', '40000000-0000-0000-0000-000000000001', 2, '2026-08-11T12:00:00Z', 200000, 1000000, '{bob}', '{"p":[]}'),
  ('payout3', '40000000-0000-0000-0000-000000000001', 3, '2026-08-12T12:00:00Z', 200000, 1000000, '{bob}', '{"p":[]}'),
  ('payout4', '40000000-0000-0000-0000-000000000001', 4, '2026-08-13T12:00:00Z', 200000, 1000000, '{bob}', '{"p":[]}'),
  ('payment1', '40000000-0000-0000-0000-000000000001', 5, '2026-08-14T12:00:00Z', 200000, 9000000, '{addr_host,addr_dev}', '{"o":[]}');

create function pg_temp.payout_plan(p_tasks jsonb, p_payouts jsonb) returns jsonb language sql as $$
  select jsonb_build_object('kind', 'payout', 'treasuryId', '40000000-0000-0000-0000-000000000001',
    'txCbor', '84a0', 'description', 'Payout: test', 'signedAddresses', '["admin"]'::jsonb,
    'createdBy', 'admin', 'blockTime', '2026-08-10T12:00:00Z', 'contributors', '["alice","bob"]'::jsonb,
    'assets', '[{"fieldName":"GVTT","unit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa47565454","decimals":2}]'::jsonb,
    'tasks', p_tasks, 'payouts', p_payouts, 'payments', '[]'::jsonb)
$$;
create function pg_temp.stub(p_number int, p_mode text,
  p_workgroup text default '20000000-0000-0000-0000-000000000001') returns jsonb language sql as $$
  select jsonb_build_object('chainNumber', p_number, 'mode', p_mode, 'taskId', null,
    'workgroupId', p_workgroup, 'title', 'Imported task #' || p_number, 'amounts', '{"ADA":"2"}'::jsonb,
    'bountyLovelace', '2000000', 'budgetMonth', '2026-07-01', 'wallets', '["bob"]'::jsonb)
$$;

set local role service_role;
do $$
declare r jsonb; t tasks; n int;
begin
  -- 1. One transaction: settle #1 (alice), keep the free number #7 (bob).
  r := import_chain_tx('payout1', pg_temp.payout_plan(
    jsonb_build_array(
      jsonb_build_object('chainNumber', 1, 'mode', 'settle', 'taskId', '30000000-0000-0000-0000-000000000001',
        'workgroupId', '20000000-0000-0000-0000-000000000001', 'budgetMonth', '2026-07-01'),
      pg_temp.stub(7, 'keep')),
    '[{"chainNumber":1,"wallet":"alice","unit":"lovelace","amount":"5000000"},
      {"chainNumber":7,"wallet":"bob","unit":"lovelace","amount":"2000000"}]'));
  if r->>'status' <> 'imported' then raise exception 'Expected imported, got %', r; end if;
  if exists (select 1 from external_txs where tx_hash = 'payout1') then
    raise exception 'The external row must be dropped';
  end if;

  select * into t from tasks where id = '30000000-0000-0000-0000-000000000001';
  if t.pay_state <> 'paid' or t.paid_tx_hash <> 'payout1' or t.budget_month <> '2026-07-01'
    or t.column_id <> '50000000-0000-0000-0000-000000000002' or t.chain_number is not null then
    raise exception 'Settled task: %', to_jsonb(t);
  end if;
  select * into t from tasks where community_id = '10000000-0000-0000-0000-000000000000' and number = 7;
  if not found or t.chain_number <> 7 or t.pay_state <> 'paid' or t.source <> 'native'
    or t.column_id <> '50000000-0000-0000-0000-000000000002' or t.bounty_lovelace <> 2000000
    or t.created_at <> '2026-08-10T12:00:00Z' then
    raise exception 'Imported task keeps its chain number: %', to_jsonb(t);
  end if;
  if not exists (select 1 from task_assignees where task_id = t.id and source = 'manual' and wallet_address = 'bob') then
    raise exception 'The recipient becomes a manual assignee';
  end if;
  if exists (select 1 from community_members where wallet_address = 'bob') then
    raise exception 'A recipient is never added to the community';
  end if;
  if not exists (select 1 from transactions where tx_hash = 'payout1' and state = 2 and kind = 'payout'
      and tx_cbor = '84a0' and signed_addresses = '{admin}' and submitted_at = '2026-08-10T12:00:00Z'
      and discord_notified_at is not null) then
    raise exception 'An imported transaction is confirmed history, never announced';
  end if;
  select count(*) into n from payouts p join transactions x on x.id = p.transaction_id
    where x.tx_hash = 'payout1' and p.status = 'confirmed' and p.created_at = '2026-08-10T12:00:00Z';
  if n <> 2 then raise exception 'Expected 2 confirmed payouts, got %', n; end if;
  if not exists (select 1 from community_assets where field_name = 'GVTT' and decimals = 2) then
    raise exception 'A ticker resolved from the transaction joins the registry';
  end if;

  -- 2. Numbering carries on from the kept number.
  insert into tasks(workgroup_id, source, title)
    values ('20000000-0000-0000-0000-000000000001', 'native', 'Next') returning number into n;
  if n <> 8 then raise exception 'Expected #8 after a kept #7, got %', n; end if;

  -- 3. Idempotent: the row is gone.
  r := import_chain_tx('payout1', pg_temp.payout_plan('[]', '[]'));
  if r->>'status' <> 'gone' then raise exception 'Expected gone, got %', r; end if;
  -- A recorded hash with a fresh external row (cursor reset) is dropped, not doubled.
  insert into external_txs(tx_hash, treasury_id, block_height, block_time, fee_lovelace, amount_lovelace)
    values ('payout1', '40000000-0000-0000-0000-000000000001', 1, now(), 0, 0);
  r := import_chain_tx('payout1', pg_temp.payout_plan('[]', '[]'));
  if r->>'status' <> 'already' or exists (select 1 from external_txs where tx_hash = 'payout1') then
    raise exception 'Expected already, got %', r;
  end if;
  select count(*) into n from transactions where tx_hash = 'payout1';
  if n <> 1 then raise exception 'Imported twice'; end if;

  -- 4. A new number: max + 1, with the chain number kept beside it.
  r := import_chain_tx('payout2', pg_temp.payout_plan(jsonb_build_array(pg_temp.stub(2, 'new')),
    '[{"chainNumber":2,"wallet":"bob","unit":"lovelace","amount":"2000000"}]'));
  if (r->'numbers'->>'2')::int <> 9 then raise exception 'Expected #9 for chain #2, got %', r; end if;
  if not exists (select 1 from tasks where number = 9 and chain_number = 2) then
    raise exception 'The chain number is stored on a renumbered task';
  end if;
end $$;

-- 5. Refusals roll everything back and leave the external row: a kept number
-- in use, a settle of a task that is not payable (after a good insert in the
-- same plan), an archived workgroup, another treasury's row.
select pg_temp.reject($q$ select import_chain_tx('payout3', pg_temp.payout_plan(
  jsonb_build_array(pg_temp.stub(2, 'keep')), '[]')) $q$, '23505');
select pg_temp.reject($q$ select import_chain_tx('payout3', pg_temp.payout_plan(
  jsonb_build_array(pg_temp.stub(30, 'keep'), jsonb_build_object('chainNumber', 2, 'mode', 'settle',
    'taskId', '30000000-0000-0000-0000-000000000002', 'workgroupId', '20000000-0000-0000-0000-000000000001',
    'budgetMonth', '2026-07-01')), '[]')) $q$, 'P0001');
select pg_temp.reject($q$ select import_chain_tx('payout3', pg_temp.payout_plan(
  jsonb_build_array(pg_temp.stub(31, 'keep', '20000000-0000-0000-0000-000000000002')), '[]')) $q$, '23514');
select pg_temp.reject($q$ select import_chain_tx('payout4', jsonb_set(pg_temp.payout_plan('[]', '[]'),
  '{treasuryId}', '"40000000-0000-0000-0000-000000000002"')) $q$, '23514');
do $$
begin
  if exists (select 1 from tasks where number in (30, 31))
    or exists (select 1 from transactions where tx_hash = 'payout3') then
    raise exception 'A refused import must leave nothing behind';
  end if;
  if not exists (select 1 from external_txs where tx_hash = 'payout3') then
    raise exception 'A refused import keeps its external row';
  end if;
end $$;

-- 6. A payment: spend carries a budget month, a transfer its treasury.
do $$
declare r jsonb;
begin
  r := import_chain_tx('payment1', jsonb_build_object('kind', 'payment',
    'treasuryId', '40000000-0000-0000-0000-000000000001', 'txCbor', '84a0', 'description', 'Payment: test',
    'signedAddresses', '[]'::jsonb, 'createdBy', 'admin', 'blockTime', '2026-08-14T12:00:00Z',
    'payments', '[
      {"recipientWallet":"addr_host","recipientTreasuryId":null,"label":"@host","unit":"lovelace","amount":"7000000","budgetMonth":"2026-08-01"},
      {"recipientWallet":"addr_dev","recipientTreasuryId":"40000000-0000-0000-0000-000000000002","label":"Dev","unit":"lovelace","amount":"2000000","budgetMonth":null}]'::jsonb));
  if r->>'status' <> 'imported' then raise exception 'Expected imported payment, got %', r; end if;
  if (select count(*) from payments p join transactions x on x.id = p.transaction_id
      where x.tx_hash = 'payment1' and x.kind = 'payment' and x.state = 2
        and (p.recipient_treasury_id is null) = (p.budget_month is not null)) <> 2 then
    raise exception 'Payment rows must match what build-payment writes';
  end if;
end $$;

-- 7. Chain numbers are permanent, and only the service role sets one.
select pg_temp.reject($q$ update tasks set chain_number = 99 where number = 7 $q$, '23514');
select pg_temp.reject($q$ update tasks set chain_number = null where number = 9 $q$, '23514');
reset role;
select set_config('request.jwt.claims', '{"wallet":"admin"}', true);
set local role authenticated;
select pg_temp.reject($q$ insert into tasks(workgroup_id, source, title, number, chain_number)
  values ('20000000-0000-0000-0000-000000000001', 'native', 'Picked', 500, 500) $q$, '42501');
insert into tasks(workgroup_id, source, title, number)
  values ('20000000-0000-0000-0000-000000000001', 'native', 'Browser task', 500);
do $$
begin
  if not exists (select 1 from tasks where title = 'Browser task' and number = 10) then
    raise exception 'A browser insert never picks its number';
  end if;
end $$;
select pg_temp.reject($q$ insert into workgroup_import_aliases(community_id, name, workgroup_id, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'Runs', '20000000-0000-0000-0000-000000000001', 'admin') $q$, '42501');
select pg_temp.reject($q$ select import_chain_tx('payout4', '{}'::jsonb) $q$, '42501');
reset role;

rollback;
\echo Chain import tests passed.
