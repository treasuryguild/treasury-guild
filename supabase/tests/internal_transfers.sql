-- Migration 0034: internal transfer tagging. Run with psql -f against an EMPTY
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

insert into contributors(wallet_address) values ('admin');
insert into communities(id, slug, name, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 'admin'),
  ('10000000-0000-0000-0000-000000000002', 'other', 'Other', 'admin');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Dev', 0, 1, 'addr_dev', '00'),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'Elsewhere', 0, 1, 'addr_other', '00');
insert into incoming_txs(tx_hash, treasury_id, from_addresses, amount_lovelace, block_time, incoming_type, requires_reconciliation, matched) values
  -- Main → Dev, still unclassified: becomes a logged transfer.
  ('t1', '40000000-0000-0000-0000-000000000002', '{addr_main,addr_main}', 5000000, now(), 'unclassified', true, false),
  -- Main → Dev, already classified by an admin: keeps its type, gains the link.
  ('t2', '40000000-0000-0000-0000-000000000002', '{addr_main}', 1000000, now(), 'contribution', false, true),
  -- From another community's treasury: an outside inflow like any other.
  ('t3', '40000000-0000-0000-0000-000000000001', '{addr_other}', 2000000, now(), 'unclassified', true, false),
  -- From a stranger.
  ('t4', '40000000-0000-0000-0000-000000000001', '{addr_someone}', 3000000, now(), 'unclassified', true, false);
insert into external_txs(tx_hash, treasury_id, block_height, block_time, fee_lovelace, amount_lovelace, to_addresses) values
  ('t1', '40000000-0000-0000-0000-000000000001', 1, now(), 200000, 5000000, '{addr_dev}'),
  ('e2', '40000000-0000-0000-0000-000000000001', 2, now(), 200000, 7000000, '{addr_someone,addr_other}');

\ir ../migrations/0034_internal_transfers.sql

set local role service_role;
do $$
declare dev uuid := '40000000-0000-0000-0000-000000000002'; main uuid := '40000000-0000-0000-0000-000000000001';
begin
  if not exists (select 1 from incoming_txs where tx_hash = 't1' and from_treasury_id = main
      and incoming_type = 'transfer' and not requires_reconciliation and matched) then
    raise exception 'Unclassified inflow from the other treasury must become a logged transfer';
  end if;
  if not exists (select 1 from incoming_txs where tx_hash = 't2' and from_treasury_id = main
      and incoming_type = 'contribution' and not requires_reconciliation and matched) then
    raise exception 'A classified inflow keeps its type and gains the link';
  end if;
  if exists (select 1 from incoming_txs where tx_hash in ('t3', 't4')
      and (from_treasury_id is not null or incoming_type <> 'unclassified' or not requires_reconciliation)) then
    raise exception 'Inflows from outside the community must stay in review';
  end if;
  if (select to_treasury_id from external_txs where tx_hash = 't1') is distinct from dev
    or (select to_treasury_id from external_txs where tx_hash = 'e2') is not null then
    raise exception 'Outgoing rows are tagged only for the community''s own wallets';
  end if;
  if tag_internal_transfers('10000000-0000-0000-0000-000000000000') <> 0 then
    raise exception 'Re-running the tagging must be a no-op';
  end if;
  -- An admin reclassifies a transfer; a later run leaves that alone.
  update incoming_txs set incoming_type = 'other' where tx_hash = 't1';
  perform tag_internal_transfers('10000000-0000-0000-0000-000000000000');
  if (select incoming_type from incoming_txs where tx_hash = 't1') <> 'other' then
    raise exception 'Manual classification must survive re-tagging';
  end if;
end $$;
reset role;

set local role authenticated;
do $$
begin
  begin
    perform tag_internal_transfers('10000000-0000-0000-0000-000000000000');
    raise exception 'Browser role must not tag transfers';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
\echo Internal transfer tests passed.
