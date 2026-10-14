-- Migration 0050: previous-wallet history (legacy_* tables, import_legacy_history,
-- workgroups with history cannot be deleted). Run with psql -f against an EMPTY
-- disposable PostgreSQL database; everything is rolled back.
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

insert into contributors(wallet_address) values ('admin'), ('member'), ('other');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'Other', 0, 'other');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'owner');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Governance', 'native'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Empty', 'native'),
  ('20000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000009', 'Foreign', 'native');
insert into legacy_wallets(id, community_id, name, created_by) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Old wallet', 'admin'),
  ('30000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000009', 'Theirs', 'other');

-- One CSV line as the planner builds it: ADA and AGIX.
create function pg_temp.line(n int, key text, wg text default '20000000-0000-0000-0000-000000000001') returns jsonb
language sql as $$
  select jsonb_build_object(
    'lineNo', n, 'workgroupId', wg, 'workgroupRef', 'governance', 'recipientRef', 'f39ntm',
    'task', 'Task ' || n, 'paidOn', '2026-09-15', 'budgetMonth', '2026-09-01',
    'dedupeKey', lpad(key, 64, '0'),
    'amounts', jsonb_build_array(
      jsonb_build_object('unit', 'lovelace', 'ticker', 'ADA', 'decimals', 6, 'amount', '80000000'),
      jsonb_build_object('unit', repeat('ab', 28) || '41474958', 'ticker', 'AGIX', 'decimals', 8, 'amount', '48000000000')))
$$;

-- 1. An import writes its lines and amounts; repeats inside one file are all kept.
do $$
declare r jsonb;
begin
  r := import_legacy_history('30000000-0000-0000-0000-000000000001', 'history.csv', 'admin',
    jsonb_build_array(pg_temp.line(2, 'a'), pg_temp.line(3, 'b'), pg_temp.line(4, 'b')));
  if (r->>'inserted')::int <> 3 or (r->>'skipped')::int <> 0 or (r->>'replaced')::boolean then
    raise exception 'first import returned %', r;
  end if;
  if (select count(*) from legacy_payment_amounts) <> 6 then
    raise exception 'amounts were not written';
  end if;
  if (select line_count from legacy_imports where id = (r->>'importId')::uuid) <> 3 then
    raise exception 'line count not stored';
  end if;
end $$;

-- 2. Re-importing skips what the wallet holds, unless duplicates are asked for.
do $$
declare r jsonb;
begin
  r := import_legacy_history('30000000-0000-0000-0000-000000000001', 'more.csv', 'admin',
    jsonb_build_array(pg_temp.line(2, 'a'), pg_temp.line(3, 'c')));
  if (r->>'inserted')::int <> 1 or (r->>'skipped')::int <> 1 then
    raise exception 'second import returned %', r;
  end if;
  if (select line_count from legacy_imports where id = (r->>'importId')::uuid) <> 1 then
    raise exception 'line count counts skipped lines';
  end if;
  r := import_legacy_history('30000000-0000-0000-0000-000000000001', 'again.csv', 'admin',
    jsonb_build_array(pg_temp.line(2, 'a')), null, false);
  if (r->>'inserted')::int <> 1 then
    raise exception 'an included duplicate was skipped: %', r;
  end if;
end $$;
select pg_temp.reject($q$ select import_legacy_history('30000000-0000-0000-0000-000000000001', 'same.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'a'))) $q$, '23514');
do $$ begin
  if (select count(*) from legacy_imports) <> 3 then
    raise exception 'a refused import left a batch behind';
  end if;
end $$;

-- 3. Replace swaps a batch atomically; a refused replace keeps the old one.
do $$
declare
  old_id uuid := (select id from legacy_imports where file_name = 'history.csv');
  r jsonb;
begin
  r := import_legacy_history('30000000-0000-0000-0000-000000000001', 'fixed.csv', 'admin',
    jsonb_build_array(pg_temp.line(2, 'b'), pg_temp.line(3, 'd')), old_id);
  -- 'b' was held only by the replaced batch, so it is new again.
  if (r->>'inserted')::int <> 2 or not (r->>'replaced')::boolean then
    raise exception 'replace returned %', r;
  end if;
  if exists (select 1 from legacy_imports where id = old_id) then
    raise exception 'the replaced batch is still there';
  end if;
end $$;
do $$
declare keep uuid := (select id from legacy_imports where file_name = 'fixed.csv');
begin
  perform pg_temp.reject(format($q$ select import_legacy_history('30000000-0000-0000-0000-000000000001', 'bad.csv', 'admin',
    jsonb_build_array(pg_temp.line(2, 'e', '20000000-0000-0000-0000-000000000009')), %L) $q$, keep), '23503');
  perform pg_temp.reject(format($q$ select import_legacy_history('30000000-0000-0000-0000-000000000001', 'none.csv', 'admin',
    jsonb_build_array(pg_temp.line(2, 'a')), %L) $q$, keep), '23514');
  if not exists (select 1 from legacy_imports where id = keep) then
    raise exception 'a refused replace dropped the old batch';
  end if;
end $$;

-- 4. Who and what the RPC refuses.
select pg_temp.reject($q$ select import_legacy_history('30000000-0000-0000-0000-000000000001', 'x.csv', 'member',
  jsonb_build_array(pg_temp.line(2, 'f'))) $q$, '42501');
select pg_temp.reject($q$ select import_legacy_history('30000000-0000-0000-0000-000000000009', 'x.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'f'))) $q$, '42501');
select pg_temp.reject($q$ select import_legacy_history('30000000-0000-0000-0000-00000000dead', 'x.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'f'))) $q$, 'P0002');
select pg_temp.reject($q$ select import_legacy_history('30000000-0000-0000-0000-000000000001', 'x.csv', 'admin',
  '[]'::jsonb) $q$, '23514');
select pg_temp.reject($q$ select import_legacy_history('30000000-0000-0000-0000-000000000001', 'x.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'f') || '{"amounts": []}')) $q$, '23514');
select pg_temp.reject($q$ select import_legacy_history('30000000-0000-0000-0000-000000000001', 'x.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'f')), '30000000-0000-0000-0000-000000000009') $q$, 'P0002');

-- 5. Column rules.
select pg_temp.reject($q$ select import_legacy_history('30000000-0000-0000-0000-000000000001', 'x.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'g') || '{"budgetMonth": "2026-09-15"}')) $q$, '23514');
select pg_temp.reject($q$ select import_legacy_history('30000000-0000-0000-0000-000000000001', 'x.csv', 'admin',
  jsonb_build_array(pg_temp.line(2, 'g') || '{"recipientRef": "f3bntm"}')) $q$, '23514');
select pg_temp.reject($q$ insert into legacy_payment_amounts(payment_id, unit, ticker, decimals, amount)
  select id, 'lovelace', 'ADA', 6, 1.5 from legacy_payments limit 1 $q$, '23514');
select pg_temp.reject($q$ insert into legacy_wallets(community_id, name, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'OLD WALLET', 'admin') $q$, '23505');

-- 6. A workgroup with history cannot be deleted until its history is gone.
select pg_temp.reject($q$ delete from workgroups where id = '20000000-0000-0000-0000-000000000001' $q$, '23514');
delete from workgroups where id = '20000000-0000-0000-0000-000000000002';
delete from legacy_imports where legacy_wallet_id = '30000000-0000-0000-0000-000000000001';
do $$ begin
  if exists (select 1 from legacy_payments) or exists (select 1 from legacy_payment_amounts) then
    raise exception 'deleting imports did not cascade';
  end if;
end $$;
delete from workgroups where id = '20000000-0000-0000-0000-000000000001';

-- 7. The browser roles see nothing and cannot run the import.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
select pg_temp.reject($q$ select * from legacy_wallets $q$, '42501');
select pg_temp.reject($q$ select * from legacy_payments $q$, '42501');
select pg_temp.reject($q$ select import_legacy_history('30000000-0000-0000-0000-000000000001', 'x.csv', 'admin', '[]'::jsonb) $q$, '42501');
reset role;
set local role anon;
select pg_temp.reject($q$ select * from legacy_payment_amounts $q$, '42501');
reset role;

-- 8. Deleting a previous wallet removes its imports and lines.
insert into legacy_imports(id, community_id, legacy_wallet_id, file_name, line_count, created_by) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000009', '30000000-0000-0000-0000-000000000009', 'f.csv', 1, 'other');
insert into legacy_payments(import_id, community_id, legacy_wallet_id, workgroup_id, workgroup_ref, recipient_ref,
  task, paid_on, budget_month, line_no, dedupe_key) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000009', '30000000-0000-0000-0000-000000000009',
   '20000000-0000-0000-0000-000000000009', 'foreign', 'f39ntm', 'T', '2026-09-01', '2026-09-01', 2, repeat('0', 64));
delete from legacy_wallets where id = '30000000-0000-0000-0000-000000000009';
do $$ begin
  if exists (select 1 from legacy_imports) or exists (select 1 from legacy_payments) then
    raise exception 'a deleted previous wallet kept its history';
  end if;
end $$;
delete from workgroups where id = '20000000-0000-0000-0000-000000000009';

rollback;
\echo Legacy history tests passed.
