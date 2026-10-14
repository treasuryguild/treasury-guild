-- Head schema (migrations 0001-0058): the add_signature RPC (defined in 0002,
-- locked to the service role in 0007, answering false on a miss since 0058). Run with psql -f
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
-- "cbor|signers|rejecters|state" of a transaction.
create function pg_temp.tx(tx_id uuid) returns text language sql as $$
  select tx_cbor || '|' || array_to_string(signed_addresses, ',') || '|' || array_to_string(rejected_addresses, ',') || '|' || state
  from transactions where id = tx_id
$$;

insert into contributors(wallet_address) values ('alice'), ('bob'), ('carol');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'alice');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'alice', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'bob', 'member');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 2, 'addr_main', '00'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Second', 0, 2, 'addr_second', '00');
insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'payout', 'c0', 'alice', 0),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'payment', 'p0', 'alice', 0),
  ('50000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000002', 'mint', 'm0', 'alice', 1),
  ('50000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000002', 'payout', 'x0', 'alice', 2),
  ('50000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000002', 'payout', 'r0', 'alice', 3);

-- 1. Only the service role may call it (0007, 0058). This fixture grants EXECUTE to
-- the API roles by default, as Supabase does, so the revoke is what is tested.
do $$ begin
  if has_function_privilege('anon', 'public.add_signature(uuid, text, text, integer)', 'execute')
      or has_function_privilege('authenticated', 'public.add_signature(uuid, text, text, integer)', 'execute') then
    raise exception 'a browser role may execute add_signature';
  end if;
  if not has_function_privilege('service_role', 'public.add_signature(uuid, text, text, integer)', 'execute') then
    raise exception 'service_role may not execute add_signature';
  end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"alice"}', true);
select pg_temp.reject($$select add_signature('50000000-0000-0000-0000-000000000001', 'alice', 'c1', 0)$$, '42501');
-- No client write policy on transactions either: an owner's direct update reaches no row.
update transactions set signed_addresses = '{alice}', tx_cbor = 'forged' where id = '50000000-0000-0000-0000-000000000001';
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.reject($$select add_signature('50000000-0000-0000-0000-000000000001', 'alice', 'c1', 0)$$, '42501');
reset role;
do $$ begin
  if pg_temp.tx('50000000-0000-0000-0000-000000000001') <> 'c0|||0' then
    raise exception 'a browser role changed the transaction: %', pg_temp.tx('50000000-0000-0000-0000-000000000001');
  end if;
end $$;

-- 2. The append, as the sign route makes it. A result is compared in a
-- statement of its own, then the row: a query does not see what a function it
-- calls has just written. A miss comes back as FALSE (NULL before 0058), which
-- the app reads as "refetch and re-sign".
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  t uuid := '50000000-0000-0000-0000-000000000001';
  other uuid := '50000000-0000-0000-0000-000000000002';
  landed boolean;
begin
  -- First signature, against the unsigned cbor.
  landed := add_signature(t, 'alice', 'c1', 0);
  if landed is not true then raise exception 'first signature did not land'; end if;
  if pg_temp.tx(t) <> 'c1|alice||0' then raise exception 'first signature stored wrongly: %', pg_temp.tx(t); end if;

  -- Stale count: bob signed the cbor he read before alice's signature landed.
  landed := add_signature(t, 'bob', 'stale', 0);
  if landed is distinct from false then raise exception 'a signature over a stale cbor landed'; end if;
  if pg_temp.tx(t) <> 'c1|alice||0' then raise exception 'a stale signature changed the transaction: %', pg_temp.tx(t); end if;
  -- A count ahead of the row is just as wrong.
  landed := add_signature(t, 'bob', 'ahead', 2);
  if landed is distinct from false then raise exception 'a signature with a count ahead of the row landed'; end if;
  landed := add_signature(t, 'bob', 'null-count', null);
  if landed is distinct from false then raise exception 'a signature without a count landed'; end if;

  -- Refetched and re-signed: it lands, appended after alice's.
  landed := add_signature(t, 'bob', 'c2', 1);
  if landed is not true then raise exception 'second signature did not land'; end if;
  if pg_temp.tx(t) <> 'c2|alice,bob||0' then raise exception 'second signature stored wrongly: %', pg_temp.tx(t); end if;

  -- The same signer twice, even with the right count.
  landed := add_signature(t, 'alice', 'again', 2);
  if landed is distinct from false then raise exception 'a duplicate signer landed'; end if;
  landed := add_signature(t, 'bob', 'again', 2);
  if landed is distinct from false then raise exception 'a duplicate signer landed'; end if;
  if pg_temp.tx(t) <> 'c2|alice,bob||0' then raise exception 'a duplicate signer changed the transaction: %', pg_temp.tx(t); end if;

  -- A third signer still lands; nothing caps the list at the treasury's threshold.
  landed := add_signature(t, 'carol', 'c3', 2);
  if landed is not true then raise exception 'third signature did not land'; end if;
  if pg_temp.tx(t) <> 'c3|alice,bob,carol||0' then raise exception 'third signature stored wrongly: %', pg_temp.tx(t); end if;

  -- Another transaction was never touched, and takes its own signatures (any kind).
  if pg_temp.tx(other) <> 'p0|||0' then raise exception 'a signature leaked onto another transaction: %', pg_temp.tx(other); end if;
  landed := add_signature(other, 'alice', 'p1', 0);
  if landed is not true then raise exception 'a payment transaction did not take a signature'; end if;
  if pg_temp.tx(other) <> 'p1|alice||0' or pg_temp.tx(t) <> 'c3|alice,bob,carol||0' then
    raise exception 'signatures crossed transactions';
  end if;

  -- An unknown transaction.
  landed := add_signature('50000000-0000-0000-0000-0000000000ff', 'alice', 'c1', 0);
  if landed is distinct from false then raise exception 'a signature landed on no transaction'; end if;
end $$;

-- 3. Only a pending transaction (state 0) takes signatures.
do $$
declare
  t uuid;
  landed boolean;
  before text;
begin
  foreach t in array array['50000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000004',
      '50000000-0000-0000-0000-000000000005']::uuid[] loop
    before := pg_temp.tx(t);
    landed := add_signature(t, 'alice', 'late', 0);
    if landed is distinct from false then raise exception 'a signature landed on a transaction in state %', right(before, 1); end if;
    if pg_temp.tx(t) <> before then raise exception 'a closed transaction changed: % -> %', before, pg_temp.tx(t); end if;
  end loop;
  -- The pending one, once submitted, is closed to a signer who was still signing.
  update transactions set state = 1, submitted_at = now() where id = '50000000-0000-0000-0000-000000000001';
  landed := add_signature('50000000-0000-0000-0000-000000000001', 'dave', 'late', 3);
  if landed is distinct from false then raise exception 'a signature landed after submission'; end if;
  -- And one rejected meanwhile (state 3), whatever the count.
  update transactions set state = 3, rejected_addresses = '{bob}' where id = '50000000-0000-0000-0000-000000000002';
  landed := add_signature('50000000-0000-0000-0000-000000000002', 'carol', 'late', 1);
  if landed is distinct from false then raise exception 'a signature landed on a rejected transaction'; end if;
  if pg_temp.tx('50000000-0000-0000-0000-000000000001') <> 'c3|alice,bob,carol||1'
      or pg_temp.tx('50000000-0000-0000-0000-000000000002') <> 'p1|alice|bob|3' then
    raise exception 'closed transactions changed';
  end if;
end $$;
reset role;

rollback;
\echo add_signature tests passed.
