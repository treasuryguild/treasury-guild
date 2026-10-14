-- Migration 0046: browser task writes (column grants + guard_task_client_write),
-- the rate limiter, and the grants it closes. Run with psql -f against an
-- EMPTY disposable PostgreSQL database; everything is rolled back.
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

insert into contributors(wallet_address, handle) values ('admin', 'Admin'), ('lead', 'Lead');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'lead', 'member');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Runs', 'native');
insert into workgroup_leads(workgroup_id, wallet_address) values
  ('20000000-0000-0000-0000-000000000001', 'lead');
insert into board_columns(id, workgroup_id, name, position, marks_payable) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Audited', 0, true);
-- #1 is on the board and payable; #2 was paid.
insert into tasks(id, workgroup_id, source, title, amounts, pay_state, audited, column_id) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'native', 'Open work', '{"ADA":"5"}', 'payable', true, '50000000-0000-0000-0000-000000000001');
insert into tasks(id, workgroup_id, source, title, amounts, pay_state, audited, paid_tx_hash) values
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'native', 'Paid work', '{"ADA":"1"}', 'paid', true, 'aa');

-- 1. A lead through the API ------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"lead"}', true);

-- The payable column still drives none <-> payable.
update tasks set pay_state = 'none', audited = false where id = '30000000-0000-0000-0000-000000000001';
update tasks set pay_state = 'payable', audited = true where id = '30000000-0000-0000-0000-000000000001';
update tasks set title = 'Open work, renamed', amounts = '{"ADA":"6"}' where id = '30000000-0000-0000-0000-000000000001';
-- A paid task can still be retitled.
update tasks set title = 'Paid work, renamed' where id = '30000000-0000-0000-0000-000000000002';

-- ...but not put back to payable, queued or paid, and it keeps its amounts.
select pg_temp.reject($$update tasks set pay_state = 'payable' where id = '30000000-0000-0000-0000-000000000002'$$, '42501');
select pg_temp.reject($$update tasks set pay_state = 'paid' where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$update tasks set pay_state = 'queued' where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$update tasks set amounts = '{"ADA":"100"}' where id = '30000000-0000-0000-0000-000000000002'$$, '23514');
select pg_temp.reject($$update tasks set budget_month = '2026-09-01' where id = '30000000-0000-0000-0000-000000000002'$$, '23514');
-- Columns the browser never writes are not granted at all.
select pg_temp.reject($$update tasks set paid_tx_hash = 'bb' where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$update tasks set source = 'github' where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$update tasks set workgroup_id = workgroup_id where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$insert into tasks(workgroup_id, title, pay_state) values ('20000000-0000-0000-0000-000000000001', 'Sneaky', 'paid')$$, '42501');
-- Adding a card works as the board does it.
insert into tasks(workgroup_id, title, column_id) values
  ('20000000-0000-0000-0000-000000000001', 'New card', '50000000-0000-0000-0000-000000000001');

-- The limiter and the closed budget RPCs are not callable from a session.
select pg_temp.reject($$select public.hit_rate_limit('x', 1, 60)$$, '42501');
select pg_temp.reject($$select public.budget_setup_workspace('10000000-0000-0000-0000-000000000000')$$, '42501');
select pg_temp.reject($$select * from rate_limits$$, '42501');
reset role;

do $$ begin
  if (select pay_state || '/' || title || '/' || (amounts ->> 'ADA') from tasks where id = '30000000-0000-0000-0000-000000000001')
    <> 'payable/Open work, renamed/6' then
    raise exception 'lead edits of the open task were not applied';
  end if;
  if (select pay_state || '/' || title || '/' || (amounts ->> 'ADA') from tasks where id = '30000000-0000-0000-0000-000000000002')
    <> 'paid/Paid work, renamed/1' then
    raise exception 'the paid task changed beyond its title';
  end if;
  if not exists (select 1 from tasks where title = 'New card' and pay_state = 'none') then
    raise exception 'the board insert did not land';
  end if;
end $$;

-- 2. Signed out -------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.reject($$select * from contributors$$, '42501');
reset role;

-- 3. The service role -----------------------------------------------------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
-- Payout code moves pay_state freely (release, confirm, reconcile).
update tasks set pay_state = 'queued' where id = '30000000-0000-0000-0000-000000000001';
update tasks set pay_state = 'payable' where id = '30000000-0000-0000-0000-000000000001';
do $$ begin
  if not public.hit_rate_limit('test:a', 2, 60) or not public.hit_rate_limit('test:a', 2, 60) then
    raise exception 'the first two hits should be allowed';
  end if;
  if public.hit_rate_limit('test:a', 2, 60) then
    raise exception 'the third hit should be refused';
  end if;
  if not public.hit_rate_limit('test:b', 2, 60) then
    raise exception 'another key has its own budget';
  end if;
  if (select hits from rate_limits where key = 'test:a') <> 3 then
    raise exception 'every hit is counted';
  end if;
end $$;
reset role;

rollback;
