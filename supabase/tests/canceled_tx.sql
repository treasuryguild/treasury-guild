-- Migration 0085: canceled transactions, spend TTL release, cosign intent.
-- Run with psql -f against an EMPTY disposable PostgreSQL database; rolled back.
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
\ir ../migrations/0085_canceled_tx_ttl.sql

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

insert into contributors(wallet_address) values ('alice'), ('bob');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'alice');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'alice', 'owner');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 2, 'addr_main', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Runs', 'native');
insert into board_columns(id, workgroup_id, name, position, marks_payable, marks_paid) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Audited', 0, true, false),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Paid', 1, false, true);
insert into tasks(id, workgroup_id, source, title, pay_state, audited, column_id) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'native', 'Cancel then confirm', 'payable', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'native', 'Cancel then TTL', 'payable', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'native', 'Signed reject-dead', 'payable', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 'native', 'Cosign race', 'payable', true, '50000000-0000-0000-0000-000000000001');

-- 1. Cancel retains the hold; confirm pays once ---------------------------------
do $$
declare
  tx uuid := '60000000-0000-0000-0000-000000000001';
  ok boolean;
begin
  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state, signed_addresses, valid_to_slot)
    values (tx, '40000000-0000-0000-0000-000000000001', 'payout', 'c1', 'hash-cancel-confirm', 'alice', 0, '{alice}', 1000);
  perform claim_tasks_for_payout(tx, array['30000000-0000-0000-0000-000000000001']::uuid[]);
  insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount, status)
    values (tx, '30000000-0000-0000-0000-000000000001', 'alice', 'lovelace', 1000000, 'pending');

  ok := cancel_pending_transaction(tx);
  if ok is not true then raise exception 'cancel failed'; end if;
  if (select state from transactions where id = tx) <> 4 then raise exception 'cancel did not set state 4'; end if;
  if (select pay_state || '|' || live_payout_tx_id::text from tasks where id = '30000000-0000-0000-0000-000000000001')
      <> 'queued|' || tx::text then
    raise exception 'cancel released the reservation';
  end if;
  -- One-pending slot is free: another pending insert must succeed.
  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state)
    values ('60000000-0000-0000-0000-0000000000aa', '40000000-0000-0000-0000-000000000001', 'payment', 'c-other', 'hash-other', 'alice', 0);
  delete from transactions where id = '60000000-0000-0000-0000-0000000000aa';

  ok := confirm_transaction(tx, '2026-10-01T12:00:00Z');
  if ok is not true then raise exception 'confirm of canceled failed'; end if;
  if (select state from transactions where id = tx) <> 2 then raise exception 'confirm did not settle canceled'; end if;
  if (select pay_state from tasks where id = '30000000-0000-0000-0000-000000000001') <> 'paid' then
    raise exception 'confirm did not pay the canceled hold';
  end if;
end $$;

-- 2. TTL release flips to Rejected and frees the hold ----------------------------
do $$
declare
  tx uuid := '60000000-0000-0000-0000-000000000002';
  n integer;
  ok boolean;
begin
  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state, signed_addresses, valid_to_slot)
    values (tx, '40000000-0000-0000-0000-000000000001', 'payout', 'c2', 'hash-ttl', 'alice', 0, '{alice}', 500);
  perform claim_tasks_for_payout(tx, array['30000000-0000-0000-0000-000000000002']::uuid[]);
  insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount, status)
    values (tx, '30000000-0000-0000-0000-000000000002', 'alice', 'lovelace', 1000000, 'pending');
  ok := cancel_pending_transaction(tx);
  if ok is not true then raise exception 'ttl cancel failed'; end if;

  -- Still within lag: no release.
  n := release_expired_canceled_transactions(0, 600, 1800);
  if n <> 0 then raise exception 'released inside lag window'; end if;
  if (select state from transactions where id = tx) <> 4 then raise exception 'premature release'; end if;

  n := release_expired_canceled_transactions(0, 500 + 1800 + 1, 1800);
  if n <> 1 then raise exception 'expected one TTL release, got %', n; end if;
  if (select state from transactions where id = tx) <> 3 then raise exception 'TTL release did not reject'; end if;
  if (select pay_state from tasks where id = '30000000-0000-0000-0000-000000000002') <> 'payable'
      or (select live_payout_tx_id from tasks where id = '30000000-0000-0000-0000-000000000002') is not null then
    raise exception 'TTL release did not free the task';
  end if;
  -- Orphan repair must not free a still-canceled hold (already released here).
  if release_orphaned_queued_tasks() <> 0 then raise exception 'orphan repair touched released rows'; end if;
end $$;

-- 3. Signed reject-dead cancels (retain); unsigned reject-dead still releases ----
do $$
declare
  signed_tx uuid := '60000000-0000-0000-0000-000000000003';
  unsigned_tx uuid := '60000000-0000-0000-0000-000000000013';
  ok boolean;
begin
  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state, signed_addresses, valid_to_slot)
    values (signed_tx, '40000000-0000-0000-0000-000000000001', 'payout', 'c3', 'hash-signed-dead', 'alice', 0, '{alice}', 9000);
  perform claim_tasks_for_payout(signed_tx, array['30000000-0000-0000-0000-000000000003']::uuid[]);
  insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount, status)
    values (signed_tx, '30000000-0000-0000-0000-000000000003', 'alice', 'lovelace', 1000000, 'pending');
  ok := reject_transaction(signed_tx, '{alice}', '{}', '{bob}', true);
  if ok is not true then raise exception 'signed reject-dead failed'; end if;
  if (select state from transactions where id = signed_tx) <> 4 then raise exception 'signed dead was not canceled'; end if;
  if (select pay_state from tasks where id = '30000000-0000-0000-0000-000000000003') <> 'queued' then
    raise exception 'signed reject-dead released the hold';
  end if;

  -- Free for unsigned path: release the canceled hold first via TTL.
  perform release_expired_canceled_transactions(0, 9000 + 1800 + 1, 1800);

  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state, signed_addresses)
    values (unsigned_tx, '40000000-0000-0000-0000-000000000001', 'payout', 'c13', 'hash-unsigned-dead', 'alice', 0, '{}');
  update tasks set pay_state = 'payable', live_payout_tx_id = null where id = '30000000-0000-0000-0000-000000000003';
  perform claim_tasks_for_payout(unsigned_tx, array['30000000-0000-0000-0000-000000000003']::uuid[]);
  insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount, status)
    values (unsigned_tx, '30000000-0000-0000-0000-000000000003', 'alice', 'lovelace', 1000000, 'pending');
  ok := reject_transaction(unsigned_tx, '{}', '{}', '{bob}', true);
  if ok is not true then raise exception 'unsigned reject-dead failed'; end if;
  if (select state from transactions where id = unsigned_tx) <> 3 then raise exception 'unsigned dead was not rejected'; end if;
  if (select pay_state from tasks where id = '30000000-0000-0000-0000-000000000003') <> 'payable' then
    raise exception 'unsigned reject-dead kept the hold';
  end if;
end $$;

-- 4. Cosign intent blocks cancel; orphans leave canceled holds alone ------------
do $$
declare
  tx uuid := '60000000-0000-0000-0000-000000000004';
  ok boolean;
begin
  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state, signed_addresses, valid_to_slot)
    values (tx, '40000000-0000-0000-0000-000000000001', 'payout', 'c4', 'hash-intent', 'alice', 0, '{alice}', null);
  perform claim_tasks_for_payout(tx, array['30000000-0000-0000-0000-000000000004']::uuid[]);
  insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount, status)
    values (tx, '30000000-0000-0000-0000-000000000004', 'alice', 'lovelace', 1000000, 'pending');

  ok := claim_cosign_intent(tx);
  if ok is not true then raise exception 'claim intent failed'; end if;
  ok := claim_cosign_intent(tx);
  if ok is distinct from false then raise exception 'second claim should fail'; end if;

  begin
    perform cancel_pending_transaction(tx);
    raise exception 'cancel during cosign intent succeeded';
  exception when serialization_failure then
    null;
  end;

  perform clear_cosign_intent(tx);
  ok := cancel_pending_transaction(tx);
  if ok is not true then raise exception 'cancel after clear failed'; end if;
  if (select state from transactions where id = tx) <> 4 then raise exception 'post-intent cancel wrong state'; end if;

  -- Null valid_to_slot: never auto-released; orphan repair must not free it.
  if release_expired_canceled_transactions(0, 999999, 0) <> 0 then
    raise exception 'null TTL canceled was auto-released';
  end if;
  if release_orphaned_queued_tasks() <> 0 then
    raise exception 'orphan repair freed a canceled hold';
  end if;
  if (select pay_state from tasks where id = '30000000-0000-0000-0000-000000000004') <> 'queued' then
    raise exception 'canceled hold was lost';
  end if;

  -- Unsigned cancel refused.
  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state, signed_addresses)
    values ('60000000-0000-0000-0000-000000000014', '40000000-0000-0000-0000-000000000001', 'payment', 'c14', 'hash-u', 'alice', 0, '{}');
  ok := cancel_pending_transaction('60000000-0000-0000-0000-000000000014');
  if ok is distinct from false then raise exception 'unsigned cancel landed'; end if;
end $$;

rollback;
