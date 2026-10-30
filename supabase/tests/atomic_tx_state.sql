-- Head schema (migrations 0001-0062): the transaction state changes that move
-- tasks with them (0062): confirm_transaction, reject_transaction,
-- delete_pending_transaction, the orphan repair, the re-created import_chain_tx
-- and cosigner_decisions.error. Run with psql -f against an EMPTY disposable
-- PostgreSQL database; everything is rolled back.
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
-- As on Supabase: new functions are executable by the API roles unless a migration revokes it.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
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
\ir ../migrations/0084_signed_delete_and_task_claim.sql

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
-- "state|signers|rejecters" of a transaction.
create function pg_temp.tx(tx_id uuid) returns text language sql as $$
  select state || '|' || array_to_string(signed_addresses, ',') || '|' || array_to_string(rejected_addresses, ',')
  from transactions where id = tx_id
$$;
-- "pay_state|paid_tx_hash|column" of a task, the column by its last digit.
create function pg_temp.task(task_id uuid) returns text language sql as $$
  select pay_state || '|' || coalesce(paid_tx_hash, '-') || '|' || coalesce(right(column_id::text, 1), '-')
  from tasks where id = task_id
$$;

insert into contributors(wallet_address) values ('alice'), ('bob'), ('carol');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'alice');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'alice', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'bob', 'member');
-- One pending transaction per treasury (0059), so three treasuries.
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 2, 'addr_main', '00'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Second', 0, 2, 'addr_second', '00'),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000', 'Third', 0, 2, 'addr_third', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Runs', 'native'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Repo', 'github'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000', 'No paid column', 'native');
insert into board_columns(id, workgroup_id, name, position, marks_payable, marks_paid) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Audited', 0, true, false),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Paid', 1, false, true),
  ('50000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 'Audited', 0, true, false);

-- Tasks as build-payout leaves them: queued, with payouts rows in a transaction.
insert into tasks(id, workgroup_id, source, title, pay_state, audited, column_id) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'native', 'Native, submitted', 'queued', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'github', 'GitHub, submitted', 'queued', true, null),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 'native', 'Native without a Paid column', 'queued', true, '50000000-0000-0000-0000-000000000003'),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 'native', 'In the rejected build', 'queued', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001', 'native', 'In another pending build', 'queued', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000001', 'native', 'In the deleted build', 'queued', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001', 'native', 'Orphan, no payouts row', 'queued', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000001', 'native', 'Orphan of an old rejection', 'queued', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000001', 'native', 'In a submitted transaction', 'queued', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000001', 'native', 'Paid outside, to settle', 'payable', true, '50000000-0000-0000-0000-000000000001');
insert into task_assignees(task_id, source, wallet_address, position) values
  ('30000000-0000-0000-0000-00000000000a', 'manual', 'alice', 0);

insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state, submitted_at) values
  -- submitted, to confirm
  ('60000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'payout', 's0', 'hash-s', 'alice', 1, now()),
  -- pending, to reject
  ('60000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'payout', 'r0', 'hash-r', 'alice', 0, null),
  -- pending, untouched throughout
  ('60000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 'payout', 'o0', 'hash-o', 'alice', 0, null),
  -- pending, to delete
  ('60000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000001', 'payout', 'd0', 'hash-d', 'alice', 0, null),
  -- rejected long ago, its task never released
  ('60000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000002', 'payout', 'x0', 'hash-x', 'alice', 3, null),
  -- submitted, stays submitted
  ('60000000-0000-0000-0000-000000000006', '40000000-0000-0000-0000-000000000002', 'payout', 'u0', 'hash-u', 'alice', 1, now());
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount, status) values
  -- One row per (task, wallet, unit): the first task is paid to two wallets.
  ('60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'bob', 'lovelace', 1000000, 'submitted'),
  ('60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'carol', 'lovelace', 1000000, 'submitted'),
  ('60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'bob', 'lovelace', 2000000, 'submitted'),
  ('60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'bob', 'lovelace', 3000000, 'submitted'),
  ('60000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000004', 'bob', 'lovelace', 1000000, 'pending'),
  ('60000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000005', 'bob', 'lovelace', 1000000, 'pending'),
  ('60000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000006', 'bob', 'lovelace', 1000000, 'pending'),
  ('60000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000008', 'bob', 'lovelace', 1000000, 'pending'),
  ('60000000-0000-0000-0000-000000000006', '30000000-0000-0000-0000-000000000009', 'bob', 'lovelace', 1000000, 'submitted');
-- Claim column (0084): queued tasks of live txs, as claim_tasks_for_payout would leave them.
update tasks t set live_payout_tx_id = p.transaction_id
from payouts p join transactions x on x.id = p.transaction_id
where p.task_id = t.id and t.pay_state = 'queued' and x.state in (0, 1, 2);

-- 1. Only the service role may call the new functions -------------------------------------
-- This fixture grants EXECUTE to the API roles by default, as Supabase does,
-- so the revokes are what is tested.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.pay_tasks_for_tx(text, uuid[])',
    'public.confirm_transaction(uuid, timestamptz)',
    'public.reject_transaction(uuid, text[], text[], text[], boolean)',
    'public.delete_pending_transaction(uuid)',
    'public.release_orphaned_queued_tasks()',
    'public.import_chain_tx(text, jsonb)',
    'public.claim_tasks_for_payout(uuid, uuid[])'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'a browser role may execute %', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then raise exception 'service_role may not execute %', f; end if;
  end loop;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"alice"}', true);
select pg_temp.reject($$select confirm_transaction('60000000-0000-0000-0000-000000000001', now())$$, '42501');
select pg_temp.reject($$select reject_transaction('60000000-0000-0000-0000-000000000002', '{}', '{}', '{alice}', true)$$, '42501');
select pg_temp.reject($$select delete_pending_transaction('60000000-0000-0000-0000-000000000004')$$, '42501');
select pg_temp.reject($$select release_orphaned_queued_tasks()$$, '42501');
select pg_temp.reject($$select pay_tasks_for_tx('forged', array['30000000-0000-0000-0000-000000000001']::uuid[])$$, '42501');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.reject($$select confirm_transaction('60000000-0000-0000-0000-000000000001', now())$$, '42501');
select pg_temp.reject($$select delete_pending_transaction('60000000-0000-0000-0000-000000000004')$$, '42501');
reset role;
do $$ begin
  if pg_temp.tx('60000000-0000-0000-0000-000000000001') <> '1||' or pg_temp.tx('60000000-0000-0000-0000-000000000002') <> '0||'
      or pg_temp.tx('60000000-0000-0000-0000-000000000004') <> '0||'
      or (select count(*) from tasks where pay_state = 'queued') <> 9 then
    raise exception 'a browser role changed something';
  end if;
end $$;

-- 2. confirm_transaction -------------------------------------------------------------------
-- A result is compared in a statement of its own, then the rows.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  s uuid := '60000000-0000-0000-0000-000000000001';
  ok boolean;
begin
  -- Only a submitted transaction: not a pending one, a rejected one or none at all.
  ok := confirm_transaction('60000000-0000-0000-0000-000000000002', '2026-10-01T12:00:00Z');
  if ok is distinct from false then raise exception 'a pending transaction was confirmed'; end if;
  ok := confirm_transaction('60000000-0000-0000-0000-000000000005', '2026-10-01T12:00:00Z');
  if ok is distinct from false then raise exception 'a rejected transaction was confirmed'; end if;
  ok := confirm_transaction('60000000-0000-0000-0000-0000000000ff', '2026-10-01T12:00:00Z');
  if ok is distinct from false then raise exception 'no transaction was confirmed'; end if;
  if pg_temp.tx('60000000-0000-0000-0000-000000000002') <> '0||' or pg_temp.tx('60000000-0000-0000-0000-000000000005') <> '3||'
      or pg_temp.task('30000000-0000-0000-0000-000000000004') <> 'queued|-|1' then
    raise exception 'a refused confirmation changed something';
  end if;

  ok := confirm_transaction(s, '2026-10-01T12:00:00Z');
  if ok is not true then raise exception 'the submitted transaction was not confirmed'; end if;
  if (select state || '|' || block_time from transactions where id = s) <> '2|' || '2026-10-01T12:00:00Z'::timestamptz then
    raise exception 'state or block time wrong: %', (select state || '|' || block_time from transactions where id = s);
  end if;
  if (select count(*) filter (where status = 'confirmed') || '/' || count(*) from payouts where transaction_id = s) <> '4/4' then
    raise exception 'payouts not confirmed';
  end if;
  -- Paid with the hash; a native task moves to its board's Paid column, a
  -- GitHub task has none, a board without a Paid column keeps the task where it is.
  if pg_temp.task('30000000-0000-0000-0000-000000000001') <> 'paid|hash-s|2' then
    raise exception 'native task: %', pg_temp.task('30000000-0000-0000-0000-000000000001');
  end if;
  if pg_temp.task('30000000-0000-0000-0000-000000000002') <> 'paid|hash-s|-' then
    raise exception 'GitHub task: %', pg_temp.task('30000000-0000-0000-0000-000000000002');
  end if;
  if pg_temp.task('30000000-0000-0000-0000-000000000003') <> 'paid|hash-s|3' then
    raise exception 'task without a Paid column: %', pg_temp.task('30000000-0000-0000-0000-000000000003');
  end if;
  -- Nothing else moved: other transactions' payouts and tasks.
  if (select count(*) from payouts where transaction_id <> s and status = 'confirmed') <> 0
      or (select count(*) from tasks where pay_state = 'paid') <> 3 then
    raise exception 'the confirmation leaked onto other rows';
  end if;

  -- A second call (a concurrent poll, a retry) answers false and changes nothing.
  ok := confirm_transaction(s, '2027-01-01T00:00:00Z');
  if ok is distinct from false then raise exception 'a confirmed transaction was confirmed again'; end if;
  if (select block_time from transactions where id = s) <> '2026-10-01T12:00:00Z' then
    raise exception 'a second confirmation rewrote the block time';
  end if;
end $$;

-- 3. reject_transaction --------------------------------------------------------------------
do $$
declare
  r uuid := '60000000-0000-0000-0000-000000000002';
  ok boolean;
begin
  -- Stale lists (a signature or a rejection landed since the route read the row).
  ok := reject_transaction(r, '{alice}', '{}', '{bob}', true);
  if ok is distinct from false then raise exception 'a rejection over a stale signer list landed'; end if;
  ok := reject_transaction(r, '{}', '{carol}', '{carol,bob}', true);
  if ok is distinct from false then raise exception 'a rejection over a stale rejecter list landed'; end if;
  if pg_temp.tx(r) <> '0||' or pg_temp.task('30000000-0000-0000-0000-000000000004') <> 'queued|-|1' then
    raise exception 'a stale rejection changed something: %', pg_temp.tx(r);
  end if;

  -- A rejection that leaves the rule reachable: recorded, nothing released.
  ok := reject_transaction(r, '{}', '{}', '{bob}', false);
  if ok is not true then raise exception 'a live rejection did not land'; end if;
  if pg_temp.tx(r) <> '0||bob' or pg_temp.task('30000000-0000-0000-0000-000000000004') <> 'queued|-|1' then
    raise exception 'a live rejection stored wrongly: %', pg_temp.tx(r);
  end if;
  -- The same call again is stale now.
  ok := reject_transaction(r, '{}', '{}', '{carol}', true);
  if ok is distinct from false then raise exception 'a second rejection over the first list landed'; end if;

  -- The rejection that kills it: rejected, and exactly its queued tasks are payable again.
  ok := reject_transaction(r, '{}', '{bob}', '{bob,carol}', true);
  if ok is not true then raise exception 'the killing rejection did not land'; end if;
  if pg_temp.tx(r) <> '3||bob,carol' then raise exception 'dead transaction stored wrongly: %', pg_temp.tx(r); end if;
  if pg_temp.task('30000000-0000-0000-0000-000000000004') <> 'payable|-|1' then
    raise exception 'the dead transaction kept its task: %', pg_temp.task('30000000-0000-0000-0000-000000000004');
  end if;
  if (select status from payouts where transaction_id = r) <> 'pending' then raise exception 'the payouts rows of a rejection are history'; end if;
  if pg_temp.task('30000000-0000-0000-0000-000000000005') <> 'queued|-|1' or pg_temp.task('30000000-0000-0000-0000-000000000006') <> 'queued|-|1'
      or pg_temp.task('30000000-0000-0000-0000-000000000009') <> 'queued|-|1' or pg_temp.task('30000000-0000-0000-0000-000000000001') <> 'paid|hash-s|2' then
    raise exception 'a rejection released or changed another transaction''s task';
  end if;

  -- Not pending any more: rejected, submitted, confirmed, unknown.
  ok := reject_transaction(r, '{}', '{bob,carol}', '{bob,carol,alice}', true);
  if ok is distinct from false then raise exception 'a rejected transaction took a rejection'; end if;
  ok := reject_transaction('60000000-0000-0000-0000-000000000006', '{}', '{}', '{bob}', true);
  if ok is distinct from false then raise exception 'a submitted transaction took a rejection'; end if;
  ok := reject_transaction('60000000-0000-0000-0000-000000000001', '{}', '{}', '{bob}', true);
  if ok is distinct from false then raise exception 'a confirmed transaction took a rejection'; end if;
  ok := reject_transaction('60000000-0000-0000-0000-0000000000ff', '{}', '{}', '{bob}', true);
  if ok is distinct from false then raise exception 'no transaction took a rejection'; end if;
  if pg_temp.tx('60000000-0000-0000-0000-000000000006') <> '1||' or pg_temp.tx('60000000-0000-0000-0000-000000000001') <> '2||'
      or pg_temp.task('30000000-0000-0000-0000-000000000009') <> 'queued|-|1' then
    raise exception 'a closed transaction changed';
  end if;
end $$;

-- 4. delete_pending_transaction ------------------------------------------------------------
do $$
declare
  d uuid := '60000000-0000-0000-0000-000000000004';
  ok boolean;
begin
  -- Never a submitted, confirmed or rejected transaction.
  ok := delete_pending_transaction('60000000-0000-0000-0000-000000000006');
  if ok is distinct from false then raise exception 'a submitted transaction was deleted'; end if;
  ok := delete_pending_transaction('60000000-0000-0000-0000-000000000001');
  if ok is distinct from false then raise exception 'a confirmed transaction was deleted'; end if;
  ok := delete_pending_transaction('60000000-0000-0000-0000-000000000002');
  if ok is distinct from false then raise exception 'a rejected transaction was deleted'; end if;
  if (select count(*) from transactions) <> 6 or (select count(*) from payouts) <> 9
      or pg_temp.task('30000000-0000-0000-0000-000000000009') <> 'queued|-|1' then
    raise exception 'a refused delete removed or released something';
  end if;

  ok := delete_pending_transaction(d);
  if ok is not true then raise exception 'the pending transaction was not deleted'; end if;
  if exists (select 1 from transactions where id = d) or exists (select 1 from payouts where transaction_id = d) then
    raise exception 'the transaction or its payouts rows survived';
  end if;
  if pg_temp.task('30000000-0000-0000-0000-000000000006') <> 'payable|-|1' then
    raise exception 'the deleted transaction kept its task: %', pg_temp.task('30000000-0000-0000-0000-000000000006');
  end if;
  if pg_temp.task('30000000-0000-0000-0000-000000000005') <> 'queued|-|1' or (select count(*) from transactions) <> 5 then
    raise exception 'the delete reached another transaction';
  end if;
  ok := delete_pending_transaction(d);
  if ok is distinct from false then raise exception 'a deleted transaction was deleted again'; end if;
end $$;

-- 4b. signed pending transactions cannot be deleted (0084) --------------------------------
do $$
declare
  s uuid := '60000000-0000-0000-0000-0000000000a4';
  ok boolean;
begin
  -- Treasury 0001's pending row was just deleted; insert a signed pending build.
  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state, signed_addresses)
    values (s, '40000000-0000-0000-0000-000000000001', 'payout', 'signed0', 'hash-signed', 'alice', 0, '{alice}');
  insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount, status) values
    (s, '30000000-0000-0000-0000-000000000006', 'bob', 'lovelace', 1000000, 'pending');
  update tasks set pay_state = 'queued', live_payout_tx_id = s
    where id = '30000000-0000-0000-0000-000000000006';

  ok := delete_pending_transaction(s);
  if ok is distinct from false then raise exception 'a signed pending transaction was deleted'; end if;
  if not exists (select 1 from transactions where id = s)
      or not exists (select 1 from payouts where transaction_id = s)
      or pg_temp.task('30000000-0000-0000-0000-000000000006') <> 'queued|-|1'
      or (select live_payout_tx_id from tasks where id = '30000000-0000-0000-0000-000000000006') is distinct from s then
    raise exception 'refusing a signed delete released the reservation';
  end if;
end $$;

-- 5. release_orphaned_queued_tasks ---------------------------------------------------------
do $$
declare
  n integer;
begin
  -- Queued with no payouts row at all, and queued with one only in a rejected transaction.
  n := release_orphaned_queued_tasks();
  if n <> 2 then raise exception 'expected 2 orphans released, got %', n; end if;
  if pg_temp.task('30000000-0000-0000-0000-000000000007') <> 'payable|-|1' or pg_temp.task('30000000-0000-0000-0000-000000000008') <> 'payable|-|1' then
    raise exception 'an orphan stayed queued';
  end if;
  -- A task of a pending or a submitted transaction is not an orphan.
  if pg_temp.task('30000000-0000-0000-0000-000000000005') <> 'queued|-|1' or pg_temp.task('30000000-0000-0000-0000-000000000009') <> 'queued|-|1' then
    raise exception 'a task of a live transaction was released';
  end if;
  if (select count(*) from tasks where pay_state = 'paid') <> 3 then raise exception 'the repair touched a paid task'; end if;
  n := release_orphaned_queued_tasks();
  if n <> 0 then raise exception 'a second repair released % more', n; end if;
end $$;

-- 6. import_chain_tx still settles and creates paid tasks (re-created to share pay_tasks_for_tx)
insert into external_txs(tx_hash, treasury_id, block_height, block_time, fee_lovelace, amount_lovelace, to_addresses, payout_meta) values
  ('outside1', '40000000-0000-0000-0000-000000000003', 1, '2026-08-10T12:00:00Z', 200000, 7000000, '{alice,bob}', '{"p":[]}'),
  ('outside2', '40000000-0000-0000-0000-000000000003', 2, '2026-08-11T12:00:00Z', 200000, 5000000, '{alice}', '{"p":[]}');
do $$
declare
  settle uuid := '30000000-0000-0000-0000-00000000000a';
  settle_number integer := (select number from tasks where id = '30000000-0000-0000-0000-00000000000a');
  free_number integer := (select max(number) + 10 from tasks);
  plan jsonb;
  r jsonb;
  t tasks;
begin
  plan := jsonb_build_object('kind', 'payout', 'treasuryId', '40000000-0000-0000-0000-000000000003',
    'txCbor', '84a0', 'description', 'Payout: test', 'signedAddresses', '["alice"]'::jsonb,
    'createdBy', 'alice', 'blockTime', '2026-08-10T12:00:00Z', 'contributors', '["alice","bob"]'::jsonb,
    'assets', '[]'::jsonb,
    'tasks', jsonb_build_array(
      jsonb_build_object('chainNumber', settle_number, 'mode', 'settle', 'taskId', settle,
        'workgroupId', '20000000-0000-0000-0000-000000000001', 'budgetMonth', '2026-07-01'),
      jsonb_build_object('chainNumber', free_number, 'mode', 'keep', 'taskId', null,
        'workgroupId', '20000000-0000-0000-0000-000000000001', 'title', 'Imported task', 'amounts', '{"ADA":"2"}'::jsonb,
        'bountyLovelace', '2000000', 'budgetMonth', '2026-07-01', 'wallets', '["bob"]'::jsonb)),
    'payouts', jsonb_build_array(
      jsonb_build_object('chainNumber', settle_number, 'wallet', 'alice', 'unit', 'lovelace', 'amount', '5000000'),
      jsonb_build_object('chainNumber', free_number, 'wallet', 'bob', 'unit', 'lovelace', 'amount', '2000000')),
    'payments', '[]'::jsonb);
  r := import_chain_tx('outside1', plan);
  if r->>'status' <> 'imported' then raise exception 'expected imported, got %', r; end if;
  select * into t from tasks where id = settle;
  if t.pay_state <> 'paid' or t.paid_tx_hash <> 'outside1' or t.budget_month <> '2026-07-01'
      or t.column_id <> '50000000-0000-0000-0000-000000000002' or t.chain_number is not null then
    raise exception 'settled task: %', to_jsonb(t);
  end if;
  select * into t from tasks where community_id = '10000000-0000-0000-0000-000000000000' and number = free_number;
  if not found or t.pay_state <> 'paid' or t.paid_tx_hash <> 'outside1' or t.chain_number <> free_number
      or t.column_id <> '50000000-0000-0000-0000-000000000002' then
    raise exception 'imported task: %', to_jsonb(t);
  end if;
  if (select count(*) from payouts p join transactions x on x.id = p.transaction_id
      where x.tx_hash = 'outside1' and x.state = 2 and p.status = 'confirmed') <> 2 then
    raise exception 'imported payouts wrong';
  end if;

  -- A settle of a task that is no longer payable is still refused whole (number_conflict).
  plan := jsonb_set(plan, '{tasks}', jsonb_build_array(plan->'tasks'->0));
  plan := jsonb_set(plan, '{payouts}', jsonb_build_array(plan->'payouts'->0));
  begin
    r := import_chain_tx('outside2', plan);
    raise exception 'a settle of a paid task was imported: %', r;
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'number_conflict' then raise; end if;
  end;
  if (select paid_tx_hash from tasks where id = settle) <> 'outside1' or not exists (select 1 from external_txs where tx_hash = 'outside2') then
    raise exception 'a refused import changed something';
  end if;

  -- A plan of any other kind is refused before anything is written.
  begin
    r := import_chain_tx('outside2', jsonb_set(plan, '{kind}', '"mint"'));
    raise exception 'a mint plan was imported: %', r;
  exception when sqlstate '23514' then
    if sqlerrm <> 'Unknown import kind' then raise; end if;
  end;
  if not exists (select 1 from external_txs where tx_hash = 'outside2') then
    raise exception 'a refused kind dropped the external row';
  end if;
end $$;

-- 7. cosigner_decisions.error --------------------------------------------------------------
-- A signing failure is a passed check whose witness was not added.
insert into cosigner_decisions(transaction_id, trigger, passed, problems, signed, error) values
  ('60000000-0000-0000-0000-000000000003', 'sweep', true, '[]', false, 'COSIGNER_KEY_SECRET is not set'),
  ('60000000-0000-0000-0000-000000000003', 'sweep', true, '[]', true, null),
  ('60000000-0000-0000-0000-000000000003', 'manual', false, '["Dev has no budget."]', false, null);
select pg_temp.reject($$insert into cosigner_decisions(transaction_id, trigger, passed, signed, error)
  values ('60000000-0000-0000-0000-000000000003', 'sweep', true, true, 'failed')$$, '23514');
select pg_temp.reject($$insert into cosigner_decisions(transaction_id, trigger, passed, signed, error)
  values ('60000000-0000-0000-0000-000000000003', 'sweep', false, false, 'failed')$$, '23514');
-- 0061's rule still holds: no witness without a pass.
select pg_temp.reject($$insert into cosigner_decisions(transaction_id, trigger, passed, signed)
  values ('60000000-0000-0000-0000-000000000003', 'sweep', false, true)$$, '23514');
reset role;
-- Members read the reason; nobody but the service role writes one.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"bob"}', true);
do $$ begin
  if (select string_agg(coalesce(error, '-'), ',' order by error nulls last) from cosigner_decisions) <> 'COSIGNER_KEY_SECRET is not set,-,-' then
    raise exception 'a member cannot read the decisions: %', (select count(*) from cosigner_decisions);
  end if;
end $$;
select pg_temp.reject($$insert into cosigner_decisions(transaction_id, trigger, passed, signed, error)
  values ('60000000-0000-0000-0000-000000000003', 'sweep', true, false, 'forged')$$, '42501');
reset role;

rollback;
\echo Atomic transaction state tests passed.
