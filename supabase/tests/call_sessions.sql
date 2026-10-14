-- Migrations 0040-0044: presence sessions (Zoom / Meet) and integration tokens. Run with psql -f
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
\ir ../migrations/0040_call_sessions.sql
\ir ../migrations/0041_github_task_delete.sql
\ir ../migrations/0042_call_pending_sessions.sql
\ir ../migrations/0043_call_meeting_links.sql
\ir ../migrations/0044_meet_meeting_links.sql

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

create function pg_temp.minutes(p_key text) returns int language sql as
  $$ select minutes from call_attendees where external_id = p_key $$;

insert into contributors(wallet_address) values
  ('addr_test_admin'), ('addr_test_member'), ('addr_test_alice'), ('addr1bob'), ('addr_test_carol');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'addr_test_admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'addr_test_admin', 'admin'),
  ('10000000-0000-0000-0000-000000000000', 'addr_test_member', 'member');
insert into workgroups(id, community_id, name) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Calls');
-- An ended call, 17:00 to 18:00.
insert into calls(id, community_id, workgroup_id, provider, title, external_ref, starts_at, ends_at, amounts, min_minutes, created_by) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
   '20000000-0000-0000-0000-000000000001', 'zoom', 'Town hall', '81234567890',
   '2026-09-01 17:00+00', '2026-09-01 18:00+00', '{"ADA":"5"}', 30, 'addr_test_admin');
insert into call_attendees(id, call_id, provider, external_id, display_name, wallet_address) values
  ('70000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000001', 'checkin', 'addr_test_carol', 'Carol', 'addr_test_carol');

do $$
declare r jsonb; cid uuid := '60000000-0000-0000-0000-000000000001';
begin
  -- Live webhook and report describe the same presence with different keys: the union counts.
  r := record_call_sessions(cid, 'zoom', '[
    {"key":"u1","name":"Alice","wallet":"addr_test_alice","joined":"2026-09-01T17:10:00Z","left":"2026-09-01T17:40:00Z","source":"zoom:wh:p1:1"},
    {"key":"u1","name":"Alice","wallet":"addr_test_alice","joined":"2026-09-01T17:00:00Z","left":"2026-09-01T17:30:00Z","source":"zoom:rp:u1:1"}]');
  if (r->>'added')::int <> 1 or (r->>'sessions')::int <> 2 then raise exception 'Wrong result: %', r; end if;
  if pg_temp.minutes('u1') <> 40 then raise exception 'Overlap not merged: %', pg_temp.minutes('u1'); end if;
  if not exists (select 1 from call_attendees where external_id = 'u1' and provider = 'zoom'
      and wallet_address = 'addr_test_alice' and first_seen = '2026-09-01 17:00+00' and last_seen = '2026-09-01 17:40+00') then
    raise exception 'Attendee not resolved'; end if;

  -- Redelivery changes nothing.
  perform record_call_sessions(cid, 'zoom', '[{"key":"u1","name":"Alice","joined":"2026-09-01T17:10:00Z","left":"2026-09-01T17:40:00Z","source":"zoom:wh:p1:1"}]');
  if pg_temp.minutes('u1') <> 40 or (select count(*) from call_attendee_sessions) <> 2 then raise exception 'Redelivery counted'; end if;

  -- Presence outside the call does not count: 16:50-17:05 is 5 minutes, a second visit adds up.
  perform record_call_sessions(cid, 'zoom', '[
    {"key":"name:dave","name":"Dave","joined":"2026-09-01T16:50:00Z","left":"2026-09-01T17:05:00Z","source":"zoom:rp:dave:1"},
    {"key":"name:dave","name":"Dave","joined":"2026-09-01T17:50:00Z","left":"2026-09-01T18:20:00Z","source":"zoom:rp:dave:2"}]');
  if pg_temp.minutes('name:dave') <> 15 then raise exception 'Not clipped to the call: %', pg_temp.minutes('name:dave'); end if;

  -- A join without a leave counts to the end of the (ended) call; the leave event closes it.
  perform record_call_sessions(cid, 'zoom', '[{"key":"name:erin","name":"Erin","joined":"2026-09-01T17:20:00Z","source":"zoom:wh:p3:1"}]');
  if pg_temp.minutes('name:erin') <> 40 then raise exception 'Open session not counted: %', pg_temp.minutes('name:erin'); end if;
  perform record_call_sessions(cid, 'zoom', '[{"key":"name:erin","name":"Erin","left":"2026-09-01T17:30:00Z"}]');
  if pg_temp.minutes('name:erin') <> 10 then raise exception 'Leave event not applied: %', pg_temp.minutes('name:erin'); end if;
  -- The report later confirms it under its own key: still 10.
  perform record_call_sessions(cid, 'zoom', '[{"key":"name:erin","name":"Erin","joined":"2026-09-01T17:20:00Z","left":"2026-09-01T17:30:00Z","source":"zoom:rp:erin:1"}]');
  if pg_temp.minutes('name:erin') <> 10 then raise exception 'Report double counted'; end if;

  -- A leave for someone never seen joining creates nothing.
  r := record_call_sessions(cid, 'zoom', '[{"key":"name:ghost","name":"Ghost","left":"2026-09-01T17:30:00Z"}]');
  if (r->>'added')::int <> 0 or exists (select 1 from call_attendees where external_id = 'name:ghost') then
    raise exception 'Ghost attendee created'; end if;

  -- Suggested wallets: wrong network and unknown wallets are dropped; a wallet
  -- already on the call (Carol checked in) takes the presence on its own row.
  perform record_call_sessions(cid, 'zoom', '[
    {"key":"name:bob","name":"Bob","wallet":"addr1bob","joined":"2026-09-01T17:00:00Z","left":"2026-09-01T18:00:00Z","source":"zoom:rp:bob:1"},
    {"key":"name:zed","name":"Zed","wallet":"addr_test_nobody","joined":"2026-09-01T17:00:00Z","left":"2026-09-01T18:00:00Z","source":"zoom:rp:zed:1"},
    {"key":"name:carol","name":"Carol (Zoom)","wallet":"addr_test_carol","joined":"2026-09-01T17:00:00Z","left":"2026-09-01T17:45:00Z","source":"zoom:rp:carol:1"}]');
  if exists (select 1 from call_attendees where external_id in ('name:bob', 'name:zed') and wallet_address is not null) then
    raise exception 'Unusable wallet was taken'; end if;
  if exists (select 1 from call_attendees where external_id = 'name:carol') then raise exception 'Checked-in attendee doubled'; end if;
  if (select minutes from call_attendees where id = '70000000-0000-0000-0000-000000000003') <> 45 then
    raise exception 'Presence not counted on the check-in row'; end if;

  perform pg_temp.reject(format('select record_call_sessions(%L, %L, %L)', cid, 'discord', '[]'), '23514');
  perform pg_temp.reject($q$select record_call_sessions('60000000-0000-0000-0000-000000000009', 'zoom', '[]')$q$, 'P0002');
  perform pg_temp.reject(format('insert into call_attendee_sessions(attendee_id, joined_at, left_at, source_key)
    values (%L, now(), now() - interval ''1 minute'', ''bad'')', '70000000-0000-0000-0000-000000000003'), '23514');
end $$;

insert into call_integrations(id, community_id, provider, external_account_id, label, created_by) values
  ('80000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'zoom', 'acct-1', 'Community Zoom', 'addr_test_admin');
insert into call_integration_secrets(integration_id, access_token, refresh_token, expires_at)
  values ('80000000-0000-0000-0000-000000000001', 'at', 'rt', now() + interval '1 hour');

-- Events parked until a call names their meeting (migration 0042): a redelivered
-- join stays one row, and a row says when something happened.
insert into call_pending_sessions(provider, external_account_id, meeting_ref, participant_key, display_name, joined_at, source_key)
  values ('zoom', 'acct-1', '81234567890', 'name:frank', 'Frank', '2026-09-01 16:58+00', 'zoom:wh:p9:1');
insert into call_pending_sessions(provider, external_account_id, meeting_ref, participant_key, display_name, left_at)
  values ('zoom', 'acct-1', '81234567890', 'name:frank', 'Frank', '2026-09-01 17:20+00');
do $$ begin
  perform pg_temp.reject($q$insert into call_pending_sessions(provider, external_account_id, meeting_ref, participant_key, display_name, joined_at, source_key)
    values ('zoom', 'acct-1', '81234567890', 'name:frank', 'Frank', '2026-09-01 16:58+00', 'zoom:wh:p9:1')$q$, '23505');
  perform pg_temp.reject($q$insert into call_pending_sessions(provider, external_account_id, meeting_ref, participant_key, display_name)
    values ('zoom', 'acct-1', '81234567890', 'name:gina', 'Gina')$q$, '23514');
  -- Replayed as one batch, the join creates the attendee and the leave closes it: 17:00-17:20.
  perform record_call_sessions('60000000-0000-0000-0000-000000000001', 'zoom', (
    select jsonb_agg(jsonb_build_object('key', participant_key, 'name', display_name,
      'joined', joined_at, 'left', left_at, 'source', source_key)) from call_pending_sessions));
  if pg_temp.minutes('name:frank') <> 20 then raise exception 'Parked events not replayed: %', pg_temp.minutes('name:frank'); end if;
end $$;

-- Linked meetings (migration 0043): one link per meeting and community, the
-- community follows the workgroup, and an occurrence gets exactly one call.
insert into call_meeting_links(id, community_id, workgroup_id, provider, meeting_ref, title, amounts, created_by) values
  ('90000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000',
   '20000000-0000-0000-0000-000000000001', 'zoom', '81234567890', 'Town hall', '{"ADA":"5"}', 'addr_test_admin');
insert into calls(workgroup_id, provider, title, external_ref, external_instance, meeting_link_id, starts_at, ends_at, amounts, created_by) values
  ('20000000-0000-0000-0000-000000000001', 'zoom', 'Town hall', '81234567890', 'uuid-A',
   '90000000-0000-0000-0000-000000000001', '2026-09-08 17:00+00', '2026-09-08 18:00+00', '{"ADA":"5"}', 'addr_test_admin');
do $$ begin
  perform pg_temp.reject($q$insert into call_meeting_links(community_id, workgroup_id, provider, meeting_ref, title, amounts, created_by)
    values ('10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001', 'zoom', '81234567890', 'Again', '{"ADA":"1"}', 'addr_test_admin')$q$, '23505');
  perform pg_temp.reject($q$insert into call_meeting_links(community_id, workgroup_id, provider, meeting_ref, title, amounts, created_by)
    values ('10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001', 'zoom', '89999999999', 'No reward', '{}', 'addr_test_admin')$q$, '23514');
  -- A second first-join of the same occurrence cannot create a second call.
  perform pg_temp.reject($q$insert into calls(workgroup_id, provider, title, external_ref, external_instance, starts_at, ends_at, amounts, created_by)
    values ('20000000-0000-0000-0000-000000000001', 'zoom', 'Town hall', '81234567890', 'uuid-A',
      '2026-09-08 17:00+00', '2026-09-08 18:00+00', '{"ADA":"5"}', 'addr_test_admin')$q$, '23505');
  -- Removing the link keeps the calls it created.
  delete from call_meeting_links where id = '90000000-0000-0000-0000-000000000001';
  if not exists (select 1 from calls where external_instance = 'uuid-A' and meeting_link_id is null) then
    raise exception 'Linked call did not survive its link'; end if;
  insert into call_meeting_links(community_id, workgroup_id, provider, meeting_ref, title, amounts, created_by)
    values ('10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001', 'zoom', '81234567890', 'Town hall', '{"ADA":"5"}', 'addr_test_admin');

  -- A Meet code can be linked too (migration 0044); its call's occurrence is the conference record.
  insert into call_meeting_links(id, community_id, workgroup_id, provider, meeting_ref, title, amounts, created_by)
    values ('90000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000',
      '20000000-0000-0000-0000-000000000001', 'meet', 'abc-mnop-xyz', 'Standup', '{"ADA":"2"}', 'addr_test_admin');
  insert into calls(workgroup_id, provider, title, external_ref, external_instance, meeting_link_id, starts_at, ends_at, amounts, created_by)
    values ('20000000-0000-0000-0000-000000000001', 'meet', 'Standup', 'abc-mnop-xyz', 'conferenceRecords/r1',
      '90000000-0000-0000-0000-000000000002', '2026-09-09 09:00+00', '2026-09-09 09:30+00', '{"ADA":"2"}', 'addr_test_admin');
  perform pg_temp.reject($q$insert into call_meeting_links(community_id, workgroup_id, provider, meeting_ref, title, amounts, created_by)
    values ('10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001', 'discord', '1153024891357143091', 'Voice', '{"ADA":"1"}', 'addr_test_admin')$q$, '23514');
  delete from call_meeting_links where id = '90000000-0000-0000-0000-000000000002';
end $$;

-- Members read presence, never tokens or parked events, and record nothing themselves.
set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claims', '{"wallet":"addr_test_member"}', true);
  if (select count(*) from call_attendee_sessions) = 0 then raise exception 'Member cannot read sessions'; end if;
  perform pg_temp.reject('select * from call_integration_secrets', '42501');
  perform pg_temp.reject('select * from call_pending_sessions', '42501');
  if (select count(*) from call_meeting_links) <> 1 then raise exception 'Member cannot read linked meetings'; end if;
  perform pg_temp.reject('delete from call_meeting_links', '42501');
  perform pg_temp.reject('delete from call_attendee_sessions', '42501');
  perform pg_temp.reject($q$select record_call_sessions('60000000-0000-0000-0000-000000000001', 'zoom', '[]')$q$, '42501');
  perform pg_temp.reject($q$select recompute_call_minutes('60000000-0000-0000-0000-000000000001')$q$, '42501');
  perform set_config('request.jwt.claims', '{"wallet":"addr1bob"}', true);
  if (select count(*) from call_attendee_sessions) <> 0 then raise exception 'Outsider can read sessions'; end if;
end $$;
reset role;

-- Disconnecting the account deletes its tokens.
delete from call_integrations where id = '80000000-0000-0000-0000-000000000001';
do $$ begin
  if exists (select 1 from call_integration_secrets) then raise exception 'Tokens survived the connection'; end if;
end $$;

rollback;
\echo Call session tests passed.
