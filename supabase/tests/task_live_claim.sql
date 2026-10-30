-- Migration 0084: claim_tasks_for_payout and signed-delete guard. Two treasuries
-- cannot claim the same payable task; multi-assignee/unit payouts under one
-- claim still work; unsigned delete releases the claim. Run with psql -f
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

insert into contributors(wallet_address) values ('alice'), ('bob');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'alice');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'alice', 'owner');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 2, 'addr_main', '00'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Second', 0, 2, 'addr_second', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Runs', 'native');
insert into board_columns(id, workgroup_id, name, position, marks_payable, marks_paid) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Audited', 0, true, false),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Paid', 1, false, true);
insert into tasks(id, workgroup_id, source, title, pay_state, audited, column_id) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'native', 'Shared', 'payable', true, '50000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'native', 'Solo', 'payable', true, '50000000-0000-0000-0000-000000000001');
insert into task_assignees(task_id, source, wallet_address, position) values
  ('30000000-0000-0000-0000-000000000001', 'manual', 'alice', 0),
  ('30000000-0000-0000-0000-000000000001', 'manual', 'bob', 1);

-- 1. First treasury claims the shared task; the second treasury is refused ------
do $$
declare
  tx1 uuid := '60000000-0000-0000-0000-000000000001';
  tx2 uuid := '60000000-0000-0000-0000-000000000002';
begin
  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state) values
    (tx1, '40000000-0000-0000-0000-000000000001', 'payout', 'c1', 'h1', 'alice', 0),
    (tx2, '40000000-0000-0000-0000-000000000002', 'payout', 'c2', 'h2', 'alice', 0);

  perform claim_tasks_for_payout(tx1, array['30000000-0000-0000-0000-000000000001']::uuid[]);
  if (select pay_state || '|' || live_payout_tx_id::text from tasks where id = '30000000-0000-0000-0000-000000000001')
      <> 'queued|' || tx1::text then
    raise exception 'first claim did not queue the task';
  end if;

  begin
    perform claim_tasks_for_payout(tx2, array['30000000-0000-0000-0000-000000000001']::uuid[]);
    raise exception 'second treasury claimed the same task';
  exception when unique_violation then
    null;
  end;

  if (select live_payout_tx_id from tasks where id = '30000000-0000-0000-0000-000000000001') is distinct from tx1 then
    raise exception 'losing claim changed the winner';
  end if;
  if exists (select 1 from payouts where transaction_id = tx2) then
    raise exception 'losing claim left payout rows';
  end if;

  -- Multi-assignee / multi-unit rows under the winning claim.
  insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount, status) values
    (tx1, '30000000-0000-0000-0000-000000000001', 'alice', 'lovelace', 1000000, 'pending'),
    (tx1, '30000000-0000-0000-0000-000000000001', 'bob', 'lovelace', 1000000, 'pending'),
    (tx1, '30000000-0000-0000-0000-000000000001', 'alice', 'token', 50, 'pending');
end $$;

-- 2. Unsigned delete releases the claim; a fresh claim then succeeds ------------
do $$
declare
  tx1 uuid := '60000000-0000-0000-0000-000000000001';
  tx3 uuid := '60000000-0000-0000-0000-000000000003';
  ok boolean;
begin
  ok := delete_pending_transaction(tx1);
  if ok is not true then raise exception 'unsigned delete failed'; end if;
  if (select pay_state from tasks where id = '30000000-0000-0000-0000-000000000001') <> 'payable'
      or (select live_payout_tx_id from tasks where id = '30000000-0000-0000-0000-000000000001') is not null then
    raise exception 'unsigned delete did not release the claim';
  end if;

  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state) values
    (tx3, '40000000-0000-0000-0000-000000000001', 'payout', 'c3', 'h3', 'alice', 0);
  perform claim_tasks_for_payout(tx3, array[
    '30000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000002'
  ]::uuid[]);
  if (select count(*) from tasks where live_payout_tx_id = tx3) <> 2 then
    raise exception 'batch claim missed a task';
  end if;
end $$;

-- 3. Overlapping batch: partial overlap refuses the whole second claim ----------
do $$
declare
  tx2 uuid := '60000000-0000-0000-0000-000000000002';
  tx3 uuid := '60000000-0000-0000-0000-000000000003';
  tx4 uuid := '60000000-0000-0000-0000-000000000004';
  solo_before text;
  ok boolean;
begin
  -- Free the second treasury's unused pending row from the first race.
  ok := delete_pending_transaction(tx2);
  if ok is not true then raise exception 'cleanup delete of unused tx2 failed'; end if;

  insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state) values
    (tx4, '40000000-0000-0000-0000-000000000002', 'payout', 'c4', 'h4', 'alice', 0);
  solo_before := (select pay_state || '|' || coalesce(live_payout_tx_id::text, '-')
    from tasks where id = '30000000-0000-0000-0000-000000000002');

  begin
    perform claim_tasks_for_payout(tx4, array[
      '30000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000002'
    ]::uuid[]);
    raise exception 'overlapping batch claim succeeded';
  exception when unique_violation then
    null;
  end;

  if (select pay_state || '|' || coalesce(live_payout_tx_id::text, '-')
        from tasks where id = '30000000-0000-0000-0000-000000000002') <> solo_before then
    raise exception 'failed overlapping claim partially claimed a free task';
  end if;
  if (select live_payout_tx_id from tasks where id = '30000000-0000-0000-0000-000000000001') is distinct from tx3 then
    raise exception 'failed overlapping claim disturbed the winner';
  end if;
end $$;

rollback;
