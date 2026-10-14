-- Migration 0061: treasury templates (clawback, lock-until, co-signer), signer
-- groups, the spending path of a transaction with its trigger, the app-held
-- co-signer key table and the co-signer decision log.
-- Run with psql -f against an EMPTY disposable PostgreSQL database; everything
-- is rolled back.
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

insert into contributors(wallet_address) values ('admin'), ('member'), ('outsider');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'Other', 0, 'outsider');
insert into community_members(community_id, wallet_address, role, created_at) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner', now() - interval '9 days'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member', now() - interval '9 days'),
  ('10000000-0000-0000-0000-000000000009', 'outsider', 'owner', now() - interval '9 days');
-- A plain treasury from before the migration, with a signer and a confirmed transaction.
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00'),
  ('40000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000009', 'Theirs', 0, 1, 'addr_theirs', '00');
insert into treasury_signers(treasury_id, wallet_address, key_hash) values
  ('40000000-0000-0000-0000-000000000001', 'admin', repeat('a', 56));
insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state)
  values ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'payout', 'a0', 'admin', 2);

\ir ../migrations/0061_treasury_templates.sql

-- 1. The migration: existing rows are plain, base and on the base path. ----------------------
do $$ begin
  if (select template from treasuries where id = '40000000-0000-0000-0000-000000000001') <> 'plain' then
    raise exception 'an existing treasury is not plain';
  end if;
  if (select signer_group from treasury_signers where treasury_id = '40000000-0000-0000-0000-000000000001') <> 'base' then
    raise exception 'an existing signer is not in the base group';
  end if;
  if (select spending_path from transactions where id = '50000000-0000-0000-0000-000000000001') <> 'base' then
    raise exception 'an existing transaction is not on the base path';
  end if;
end $$;

-- 2. The template columns come together or not at all. -----------------------------------------
select pg_temp.reject($q$ insert into treasuries(community_id, name, network, required, address, script_cbor, template)
  values ('10000000-0000-0000-0000-000000000000', 'No lock', 0, 1, 'addr_x1', '00', 'clawback') $q$, '23514');
select pg_temp.reject($q$ insert into treasuries(community_id, name, network, required, address, script_cbor, template, lock_slot, lock_until)
  values ('10000000-0000-0000-0000-000000000000', 'No recovery', 0, 1, 'addr_x2', '00', 'clawback', 100, now()) $q$, '23514');
select pg_temp.reject($q$ insert into treasuries(community_id, name, network, required, address, script_cbor, template, lock_slot)
  values ('10000000-0000-0000-0000-000000000000', 'Half lock', 0, 1, 'addr_x3', '00', 'lock_until', 100) $q$, '23514');
select pg_temp.reject($q$ insert into treasuries(community_id, name, network, required, address, script_cbor, template)
  values ('10000000-0000-0000-0000-000000000000', 'No kind', 0, 1, 'addr_x4', '00', 'cosigner') $q$, '23514');
select pg_temp.reject($q$ insert into treasuries(community_id, name, network, required, address, script_cbor, lock_slot, lock_until)
  values ('10000000-0000-0000-0000-000000000000', 'Plain with lock', 0, 1, 'addr_x5', '00', 100, now()) $q$, '23514');
select pg_temp.reject($q$ insert into treasuries(community_id, name, network, required, address, script_cbor, template, lock_slot, lock_until)
  values ('10000000-0000-0000-0000-000000000000', 'Zero slot', 0, 1, 'addr_x6', '00', 'lock_until', 0, now()) $q$, '23514');
select pg_temp.reject($q$ insert into treasuries(community_id, name, network, required, address, script_cbor, template)
  values ('10000000-0000-0000-0000-000000000000', 'Bad template', 0, 1, 'addr_x7', '00', 'vault') $q$, '23514');

insert into treasuries(id, community_id, name, network, required, address, script_cbor, template, lock_slot, lock_until, recovery_script_type, recovery_required) values
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Clawback', 0, 2, 'addr_claw', '00', 'clawback', 1000, now() + interval '1 day', 'any', 1);
insert into treasuries(id, community_id, name, network, required, address, script_cbor, template, lock_slot, lock_until) values
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000', 'Locked', 0, 1, 'addr_lock', '00', 'lock_until', 1000, now() + interval '1 day');
insert into treasuries(id, community_id, name, network, required, address, script_cbor, template, cosigner_kind) values
  ('40000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000000', 'Cosigned', 0, 2, 'addr_co', '00', 'cosigner', 'app');

-- 3. Signer groups; one key sits in one group only. -----------------------------------------
insert into treasury_signers(treasury_id, wallet_address, key_hash, signer_group) values
  ('40000000-0000-0000-0000-000000000002', 'admin', repeat('a', 56), 'base'),
  ('40000000-0000-0000-0000-000000000002', 'member', repeat('b', 56), 'recovery'),
  ('40000000-0000-0000-0000-000000000004', 'admin', repeat('a', 56), 'base'),
  ('40000000-0000-0000-0000-000000000004', 'addr_test1cosigner', repeat('c', 56), 'cosigner');
select pg_temp.reject($q$ insert into treasury_signers(treasury_id, wallet_address, key_hash, signer_group)
  values ('40000000-0000-0000-0000-000000000002', 'outsider', repeat('d', 56), 'auditor') $q$, '23514');
select pg_temp.reject($q$ insert into treasury_signers(treasury_id, wallet_address, key_hash, signer_group)
  values ('40000000-0000-0000-0000-000000000002', 'admin', repeat('a', 56), 'recovery') $q$, '23505');

-- 4. A transaction takes only a path its treasury's template offers. -------------------------
select pg_temp.reject($q$ insert into transactions(treasury_id, kind, tx_cbor, created_by, spending_path)
  values ('40000000-0000-0000-0000-000000000001', 'payment', 'b0', 'admin', 'recovery') $q$, '23514');
select pg_temp.reject($q$ insert into transactions(treasury_id, kind, tx_cbor, created_by, spending_path)
  values ('40000000-0000-0000-0000-000000000001', 'payment', 'b0', 'admin', 'cosigned') $q$, '23514');
select pg_temp.reject($q$ insert into transactions(treasury_id, kind, tx_cbor, created_by, spending_path)
  values ('40000000-0000-0000-0000-000000000003', 'payment', 'b0', 'admin', 'recovery') $q$, '23514');
select pg_temp.reject($q$ insert into transactions(treasury_id, kind, tx_cbor, created_by)
  values ('40000000-0000-0000-0000-000000000004', 'payment', 'b0', 'admin') $q$, '23514');
select pg_temp.reject($q$ insert into transactions(treasury_id, kind, tx_cbor, created_by, spending_path)
  values ('40000000-0000-0000-0000-000000000002', 'payment', 'b0', 'admin', 'sideways') $q$, '23514');
insert into transactions(id, treasury_id, kind, tx_cbor, created_by, spending_path) values
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'payment', 'b0', 'admin', 'recovery'),
  ('50000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 'payment', 'b0', 'admin', 'base'),
  ('50000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000004', 'payment', 'b0', 'admin', 'cosigned');
select pg_temp.reject($q$ update transactions set spending_path = 'bypass' where id = '50000000-0000-0000-0000-000000000002' $q$, '23514');
update transactions set spending_path = 'bypass' where id = '50000000-0000-0000-0000-000000000004';

-- 5. Decisions: a witness is only ever added after a pass. ---------------------------------
insert into cosigner_decisions(transaction_id, trigger, passed, problems, signed) values
  ('50000000-0000-0000-0000-000000000004', 'sign', false, '["Over budget"]', false),
  ('50000000-0000-0000-0000-000000000004', 'manual', true, '[]', true);
select pg_temp.reject($q$ insert into cosigner_decisions(transaction_id, trigger, passed, signed)
  values ('50000000-0000-0000-0000-000000000004', 'sign', false, true) $q$, '23514');
select pg_temp.reject($q$ insert into cosigner_decisions(transaction_id, trigger, passed)
  values ('50000000-0000-0000-0000-000000000004', 'agent', true) $q$, '23514');
insert into treasury_cosigner_keys(treasury_id, key_hash, public_key_hex, encrypted_key) values
  ('40000000-0000-0000-0000-000000000004', repeat('c', 56), repeat('e', 64), 'v1:aa:bb:cc');
select pg_temp.reject($q$ insert into treasury_cosigner_keys(treasury_id, key_hash, public_key_hex, encrypted_key)
  values ('40000000-0000-0000-0000-000000000002', 'short', repeat('e', 64), 'v1:aa:bb:cc') $q$, '23514');

-- 6. Members read the template columns, groups, paths and decisions of their community; never a key. ---
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
do $$ begin
  if (select count(*) from treasuries where template <> 'plain' and lock_until is not null) <> 2 then
    raise exception 'member cannot read the template columns';
  end if;
  if (select count(*) from treasury_signers where signer_group = 'recovery') <> 1 then
    raise exception 'member cannot read signer groups';
  end if;
  if (select spending_path from transactions where id = '50000000-0000-0000-0000-000000000002') <> 'recovery' then
    raise exception 'member cannot read the spending path';
  end if;
  if (select count(*) from cosigner_decisions) <> 2 then
    raise exception 'member cannot read the decisions of their community';
  end if;
end $$;
select pg_temp.reject($q$ select * from treasury_cosigner_keys $q$, '42501');
select pg_temp.reject($q$ insert into cosigner_decisions(transaction_id, trigger, passed)
  values ('50000000-0000-0000-0000-000000000004', 'manual', true) $q$, '42501');
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"outsider"}', true);
do $$ begin
  if (select count(*) from cosigner_decisions) <> 0 then raise exception 'outsider reads another community''s decisions'; end if;
end $$;
reset role;

-- Deleting the transaction drops its decisions; deleting the treasury drops its key.
delete from transactions where id = '50000000-0000-0000-0000-000000000004';
delete from treasuries where id = '40000000-0000-0000-0000-000000000004';
do $$ begin
  if (select count(*) from cosigner_decisions) <> 0 then raise exception 'decisions did not cascade'; end if;
  if (select count(*) from treasury_cosigner_keys) <> 0 then raise exception 'the key did not cascade'; end if;
end $$;

rollback;
\echo Treasury template tests passed.
