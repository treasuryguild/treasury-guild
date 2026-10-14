-- Migration 0039: Discord voice snapshots and attendee id privacy. Run with psql -f
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
\ir ../migrations/0036_payments_treasury_budgets.sql
\ir ../migrations/0037_calls.sql
\ir ../migrations/0038_contributor_identities.sql
\ir ../migrations/0039_call_capture.sql

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

-- A preprod community. Bob linked Discord from a mainnet wallet, Carol checked in.
insert into contributors(wallet_address) values
  ('addr_test_admin'), ('addr_test_member'), ('addr_test_alice'), ('addr1bob'), ('addr_test_carol'), ('addr_test_dave');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'addr_test_admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'addr_test_admin', 'admin'),
  ('10000000-0000-0000-0000-000000000000', 'addr_test_member', 'member');
insert into workgroups(id, community_id, name) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Calls');
insert into contributor_identities(wallet_address, provider, external_id) values
  ('addr_test_alice', 'discord', '111'), ('addr1bob', 'discord', '222'), ('addr_test_carol', 'discord', '333');
insert into calls(id, community_id, workgroup_id, provider, title, external_ref, starts_at, ends_at, amounts, min_snapshots, created_by) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
   '20000000-0000-0000-0000-000000000001', 'discord', 'Town hall', '999',
   now() - interval '10 minutes', now() + interval '50 minutes', '{"ADA":"5"}', 2, 'addr_test_admin');
insert into call_attendees(id, call_id, provider, external_id, display_name, wallet_address) values
  ('70000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000001', 'checkin', 'addr_test_carol', 'Carol', 'addr_test_carol');

do $$
declare r jsonb; cid uuid := '60000000-0000-0000-0000-000000000001';
begin
  -- Snapshot 1: a linked user, a wrong-network link, someone who checked in, a stranger (sent twice).
  r := record_call_snapshot(cid, 'manual', '[{"id":"111","name":"Alice"},{"id":"222","name":"Bob"},
    {"id":"333","name":"Carol on Discord"},{"id":"444","name":"Dave"},{"id":"444","name":"Dave"},{"id":"","name":"nobody"}]');
  if (r->>'present')::int <> 4 or (r->>'added')::int <> 3 then raise exception 'Wrong snapshot result: %', r; end if;
  if not exists (select 1 from call_attendees where call_id = cid and provider = 'discord' and external_id = '111'
      and wallet_address = 'addr_test_alice' and snapshots_seen = 1 and first_seen is not null) then
    raise exception 'Linked user not resolved'; end if;
  if not exists (select 1 from community_members where wallet_address = 'addr_test_alice') then
    raise exception 'Linked attendee did not join the community'; end if;
  if not exists (select 1 from call_attendees where call_id = cid and external_id = '222' and wallet_address is null) then
    raise exception 'A mainnet wallet was put on a preprod call'; end if;
  if exists (select 1 from community_members where wallet_address = 'addr1bob') then
    raise exception 'Wrong-network wallet joined'; end if;
  -- Carol's presence counts on her check-in row: no second row, name untouched.
  if exists (select 1 from call_attendees where call_id = cid and external_id = '333') then
    raise exception 'Checked-in attendee got a second row'; end if;
  if not exists (select 1 from call_attendees where id = '70000000-0000-0000-0000-000000000003'
      and snapshots_seen = 1 and display_name = 'Carol') then raise exception 'Presence not counted on the check-in row'; end if;
  if (select count(*) from call_attendees where call_id = cid) <> 4 then raise exception 'Wrong attendee count'; end if;

  -- Snapshot 2: presence is recomputed, names follow Discord, nobody is doubled.
  r := record_call_snapshot(cid, 'cron', '[{"id":"111","name":"Alice A."},{"id":"444","name":"Dave"}]');
  if (r->>'added')::int <> 0 then raise exception 'Known users were added again'; end if;
  if (select snapshots_seen from call_attendees where call_id = cid and external_id = '111') <> 2
    or (select display_name from call_attendees where call_id = cid and external_id = '111') <> 'Alice A.'
    or (select snapshots_seen from call_attendees where call_id = cid and external_id = '222') <> 1 then
    raise exception 'Presence not recomputed'; end if;

  -- Dave links Discord afterwards: the next snapshot gives his row the wallet.
  insert into contributor_identities(wallet_address, provider, external_id) values ('addr_test_dave', 'discord', '444');
  perform record_call_snapshot(cid, 'cron', '[{"id":"444","name":"Dave"}]');
  if not exists (select 1 from call_attendees where call_id = cid and external_id = '444'
      and wallet_address = 'addr_test_dave' and snapshots_seen = 3) then raise exception 'Later link not picked up'; end if;

  -- An empty channel is still a snapshot; a nameless user still gets a label.
  perform record_call_snapshot(cid, 'cron', '[]');
  if (select count(*) from call_snapshots where call_id = cid) <> 4 then raise exception 'Empty snapshot not recorded'; end if;
  perform record_call_snapshot(cid, 'cron', '[{"id":"777","name":"  "}]');
  if (select display_name from call_attendees where call_id = cid and external_id = '777') <> 'Discord user' then
    raise exception 'Blank name not defaulted'; end if;
  perform pg_temp.reject($q$select record_call_snapshot('60000000-0000-0000-0000-000000000009', 'cron', '[]')$q$, 'P0002');
  perform pg_temp.reject(format('select record_call_snapshot(%L, %L, %L)', cid, 'webhook', '[]'), '23514');
end $$;

-- A rewarded row is frozen: presence still counts, name and wallet do not move.
do $$
declare cid uuid := '60000000-0000-0000-0000-000000000001';
begin
  perform finalize_call(cid, 'addr_test_admin',
    (select array_agg(id) from call_attendees where call_id = cid and external_id = '111'), 20, 5000000);
  perform record_call_snapshot(cid, 'cron', '[{"id":"111","name":"Renamed"}]');
  if not exists (select 1 from call_attendees where call_id = cid and external_id = '111'
      and display_name = 'Alice A.' and snapshots_seen = 3 and task_id is not null) then
    raise exception 'Rewarded row changed'; end if;
end $$;

insert into call_integrations(community_id, provider, external_account_id, label, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'discord', '555', 'Guild server', 'addr_test_admin');
select pg_temp.reject($$insert into call_integrations(community_id, provider, external_account_id, created_by)
  values ('10000000-0000-0000-0000-000000000000', 'discord', '556', 'addr_test_admin')$$, '23505');

-- Members read the list, the snapshots and the connection, never a platform id.
set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claims', '{"wallet":"addr_test_member"}', true);
  if (select count(*) from (select id, display_name, wallet_address, snapshots_seen from call_attendees) a) <> 5 then
    raise exception 'Member cannot read attendees'; end if;
  perform pg_temp.reject('select external_id from call_attendees', '42501');
  perform pg_temp.reject('select * from call_attendees', '42501');
  if (select count(*) from call_snapshots) <> 6 or (select count(*) from call_integrations) <> 1
    or (select count(*) from call_snapshot_attendees) = 0 then raise exception 'Member cannot read capture data'; end if;
  perform pg_temp.reject($q$select record_call_snapshot('60000000-0000-0000-0000-000000000001', 'cron', '[]')$q$, '42501');
  perform pg_temp.reject('delete from call_snapshots', '42501');
  perform pg_temp.reject('delete from call_integrations', '42501');
  perform set_config('request.jwt.claims', '{"wallet":"addr1bob"}', true);
  if (select count(*) from call_snapshots) <> 0 or (select count(*) from call_integrations) <> 0 then
    raise exception 'Outsider can read capture data'; end if;
end $$;
reset role;

rollback;
\echo Call capture tests passed.
