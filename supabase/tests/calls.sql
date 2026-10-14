-- Migration 0037: call attendance and finalize_call. Run with psql -f against
-- an EMPTY disposable PostgreSQL database; everything is rolled back.
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

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

insert into contributors(wallet_address) values
  ('admin'), ('lead'), ('member'), ('outsider'), ('alice'), ('bob'), ('carol');
insert into contributors(wallet_address) select 'w' || g from generate_series(1, 41) g;
insert into communities(id, slug, name, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'admin'),
  ('10000000-0000-0000-0000-000000000000', 'lead', 'member'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member');
insert into workgroups(id, community_id, name) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Calls'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'No board');
insert into workgroup_leads(workgroup_id, wallet_address) values
  ('20000000-0000-0000-0000-000000000001', 'lead');
insert into board_columns(id, workgroup_id, name, position, marks_payable) values
  ('21000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'To Do', 0, false),
  ('21000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Audited', 1, true);

-- community_id follows the workgroup; a call never changes workgroup.
insert into calls(id, community_id, workgroup_id, provider, title, starts_at, ends_at, amounts, created_by) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
   '20000000-0000-0000-0000-000000000001', 'discord', 'Town hall',
   '2026-09-01 17:00+00', '2026-09-01 18:00+00', '{"ADA":"5"}', 'admin');
select pg_temp.reject($$update calls set workgroup_id = '20000000-0000-0000-0000-000000000002'$$, '23514');
select pg_temp.reject($$insert into calls(community_id, workgroup_id, provider, title, starts_at, ends_at, amounts, created_by)
  values ('10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001', 'manual', 'Empty reward',
  now(), now() + interval '1 hour', '{}', 'admin')$$, '23514');

insert into call_attendees(id, call_id, provider, external_id, display_name, wallet_address, status) values
  ('70000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'checkin', 'alice', 'Alice', 'alice', 'auto'),
  ('70000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001', 'manual', null, 'Bob', 'bob', 'confirmed'),
  ('70000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000001', 'manual', null, 'Guest', null, 'auto'),
  ('70000000-0000-0000-0000-000000000004', '60000000-0000-0000-0000-000000000001', 'manual', null, 'Carol', 'carol', 'excluded');

-- One reward per wallet per call, one row per platform identity.
select pg_temp.reject($$insert into call_attendees(call_id, provider, display_name, wallet_address)
  values ('60000000-0000-0000-0000-000000000001', 'manual', 'Alice again', 'alice')$$, '23505');
select pg_temp.reject($$insert into call_attendees(call_id, provider, external_id, display_name)
  values ('60000000-0000-0000-0000-000000000001', 'checkin', 'alice', 'Alice again')$$, '23505');

-- Only admins and the workgroup's leads finalize.
select pg_temp.reject($$select finalize_call('60000000-0000-0000-0000-000000000001', 'member', '{}', 20, 5000000)$$, '42501');
select pg_temp.reject($$select finalize_call('60000000-0000-0000-0000-000000000009', 'admin', '{}', 20, 5000000)$$, 'P0002');

-- Happy path: the linked, non-excluded attendees become one payable task.
do $$
declare r jsonb; t uuid;
begin
  r := finalize_call('60000000-0000-0000-0000-000000000001', 'lead', array[
    '70000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002',
    '70000000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000004']::uuid[], 20, 5000000);
  if (r->>'paid')::int <> 2 or jsonb_array_length(r->'taskIds') <> 1 or (r->>'remaining')::int <> 1 then
    raise exception 'Wrong finalize result: %', r; end if;
  t := (r->'taskIds'->>0)::uuid;
  if not exists (select 1 from tasks where id = t and source = 'native' and pay_state = 'payable' and audited
      and title = 'Call: Town hall, 2026-09-01' and amounts = '{"ADA":"5"}' and bounty_lovelace = 5000000
      and column_id = '21000000-0000-0000-0000-000000000002' and number = 1
      and community_id = '10000000-0000-0000-0000-000000000000' and budget_month is null) then
    raise exception 'Attendance task has the wrong shape'; end if;
  if (select array_agg(wallet_address order by position) from task_assignees where task_id = t and source = 'manual')
      <> array['alice', 'bob'] then raise exception 'Wrong assignees'; end if;
  if (select count(*) from call_attendees where task_id = t) <> 2 then raise exception 'Attendees not linked to the task'; end if;
  if not exists (select 1 from call_tasks where task_id = t and chunk_index = 0) then raise exception 'call_tasks row missing'; end if;
  -- The unlinked guest keeps the call open.
  if (select state from calls where id = '60000000-0000-0000-0000-000000000001') <> 'open' then
    raise exception 'Call closed with an unpaid attendee'; end if;

  -- A retry creates nothing.
  r := finalize_call('60000000-0000-0000-0000-000000000001', 'admin', array[
    '70000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002']::uuid[], 20, 5000000);
  if (r->>'paid')::int <> 0 or (select count(*) from tasks) <> 1 then raise exception 'Second finalize paid again'; end if;

  -- Linking the guest later: a follow-up task, numbered, and the call closes.
  insert into contributors(wallet_address) values ('guest');
  update call_attendees set wallet_address = 'guest' where id = '70000000-0000-0000-0000-000000000003';
  r := finalize_call('60000000-0000-0000-0000-000000000001', 'admin',
    array['70000000-0000-0000-0000-000000000003']::uuid[], 20, 5000000);
  if not exists (select 1 from tasks where id = (r->'taskIds'->>0)::uuid and title = 'Call: Town hall, 2026-09-01 (2)') then
    raise exception 'Follow-up task not numbered'; end if;
  if (select state from calls where id = '60000000-0000-0000-0000-000000000001') <> 'finalized' then
    raise exception 'Call not finalized'; end if;

  -- Deleting an attendance task frees its attendees for the next finalize.
  update tasks set archived_at = now() where id = t;
  delete from tasks where id = t;
  if (select count(*) from call_attendees where call_id = '60000000-0000-0000-0000-000000000001'
      and task_id is null and wallet_address in ('alice', 'bob')) <> 2 then
    raise exception 'Attendees not freed'; end if;
  if exists (select 1 from call_tasks where task_id = t) then raise exception 'call_tasks row survived'; end if;
end $$;

-- 41 attendees at 20 per task: balanced 14 + 14 + 13, no board column needed.
insert into calls(id, community_id, workgroup_id, provider, title, starts_at, ends_at, amounts, created_by) values
  ('60000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000',
   '20000000-0000-0000-0000-000000000002', 'zoom', 'Big call',
   '2026-09-02 17:00+00', '2026-09-02 18:00+00', '{"TOKEN":"10"}', 'admin');
insert into call_attendees(call_id, provider, display_name, wallet_address)
  select '60000000-0000-0000-0000-000000000002', 'manual', 'W' || g, 'w' || g from generate_series(1, 41) g;
do $$
declare r jsonb; sizes int[];
begin
  r := finalize_call('60000000-0000-0000-0000-000000000002', 'admin',
    (select array_agg(id) from call_attendees where call_id = '60000000-0000-0000-0000-000000000002'), 20, null);
  if jsonb_array_length(r->'taskIds') <> 3 or (r->>'paid')::int <> 41 then raise exception 'Wrong chunking: %', r; end if;
  select array_agg(n order by chunk_index) into sizes from (
    select ct.chunk_index, count(*)::int as n from call_tasks ct
      join task_assignees ta on ta.task_id = ct.task_id
      where ct.call_id = '60000000-0000-0000-0000-000000000002' group by ct.chunk_index) s;
  if sizes <> array[14, 14, 13] then raise exception 'Unbalanced chunks: %', sizes; end if;
  if (select count(distinct wallet_address) from task_assignees ta join call_tasks ct on ct.task_id = ta.task_id
      where ct.call_id = '60000000-0000-0000-0000-000000000002') <> 41 then raise exception 'A wallet is missing or doubled'; end if;
  if exists (select 1 from tasks t join call_tasks ct on ct.task_id = t.id
      where ct.call_id = '60000000-0000-0000-0000-000000000002'
      and (t.column_id is not null or t.bounty_lovelace is not null or t.title not like 'Call: Big call, 2026-09-02 (%)')) then
    raise exception 'Chunk tasks have the wrong shape'; end if;
end $$;

-- Members read calls and attendees, never codes or aliases; nobody writes or
-- finalizes through RLS.
insert into call_checkin_codes(call_id, code, created_by) values ('60000000-0000-0000-0000-000000000001', 'ABC234', 'admin');
insert into call_name_aliases(community_id, normalized_name, wallet_address, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'alice', 'alice', 'admin');
set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claims', '{"wallet":"member"}', true);
  if (select count(*) from calls) <> 2 then raise exception 'Member cannot read calls'; end if;
  if (select count(*) from call_attendees) <> 45 then raise exception 'Member cannot read attendees'; end if;
  if (select count(*) from call_tasks) <> 4 then raise exception 'Member cannot read call tasks'; end if;
  perform pg_temp.reject('select * from call_checkin_codes', '42501');
  perform pg_temp.reject('select * from call_name_aliases', '42501');
  perform pg_temp.reject($q$update calls set title = 'x'$q$, '42501');
  perform pg_temp.reject($q$update call_attendees set status = 'confirmed'$q$, '42501');
  perform pg_temp.reject($q$select finalize_call('60000000-0000-0000-0000-000000000001', 'admin', '{}', 20, null)$q$, '42501');
  perform set_config('request.jwt.claims', '{"wallet":"outsider"}', true);
  if (select count(*) from calls) <> 0 or (select count(*) from call_attendees) <> 0 then
    raise exception 'Outsider can read calls'; end if;
end $$;
reset role;

-- Archived workgroups refuse a finalize (a workgroup holding payable tasks
-- cannot be archived, hence a fresh one).
insert into workgroups(id, community_id, name) values
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000', 'Archived');
insert into calls(id, community_id, workgroup_id, provider, title, starts_at, ends_at, amounts, created_by) values
  ('60000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000',
   '20000000-0000-0000-0000-000000000003', 'meet', 'Old call',
   '2026-09-03 17:00+00', '2026-09-03 18:00+00', '{"ADA":"1"}', 'admin');
insert into call_attendees(id, call_id, provider, display_name, wallet_address) values
  ('70000000-0000-0000-0000-000000000009', '60000000-0000-0000-0000-000000000003', 'manual', 'Alice', 'alice');
select change_workgroup_lifecycle('20000000-0000-0000-0000-000000000003', 'archive', 'admin');
select pg_temp.reject($$select finalize_call('60000000-0000-0000-0000-000000000003', 'admin',
  array['70000000-0000-0000-0000-000000000009']::uuid[], 20, 1000000)$$, '23514');

rollback;
\echo Call attendance tests passed.
