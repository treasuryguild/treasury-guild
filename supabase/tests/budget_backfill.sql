-- Migration 0051: budgets for periods before an owner's first setup
-- (backfill). Run with psql -f against an EMPTY disposable PostgreSQL database;
-- everything is rolled back.
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

insert into contributors(wallet_address) values ('admin');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Runs', 'native'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Quarterly', 'native'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000', 'Mixed', 'native'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000000', 'Review', 'native');
insert into budget_setup_states(workgroup_id, legacy_conflict) values ('20000000-0000-0000-0000-000000000004', true);

create function pg_temp.rev(wg uuid) returns integer language sql as
  $$ select coalesce((select revision from budget_setup_states where workgroup_id = wg), 0) $$;
create function pg_temp.ada(value text) returns jsonb language sql as
  $$ select jsonb_build_array(jsonb_build_object('unit', 'lovelace', 'amount', value, 'asset_label', 'ADA', 'decimals', 6)) $$;
create function pg_temp.refused(wg uuid, mode text, cadence text, starts date, reason text) returns boolean language plpgsql as $$
begin
  perform save_budget_setup(wg, pg_temp.rev(wg), mode, cadence, starts, pg_temp.ada('1'), 'admin', true, reason);
  return false;
exception when check_violation then return true;
end $$;

do $$
declare
  runs uuid := '20000000-0000-0000-0000-000000000001';
  quarterly uuid := '20000000-0000-0000-0000-000000000002';
  mixed uuid := '20000000-0000-0000-0000-000000000003';
  review uuid := '20000000-0000-0000-0000-000000000004';
begin
  -- An owner's very first setup may start in the past (with a reason).
  perform save_budget_setup(runs, 0, 'recurring', 'monthly', '2021-01-01', pg_temp.ada('100'), 'admin', false, 'Opening budget');

  -- 1. A recurring backfill before it runs until the first setup, which stays as it was.
  if not pg_temp.refused(runs, 'recurring', 'monthly', '2020-06-01', null) then
    raise exception 'A past backfill was accepted without a reason';
  end if;
  perform save_budget_setup(runs, pg_temp.rev(runs), 'recurring', 'monthly', '2020-06-01', pg_temp.ada('50'), 'admin', false, 'Before the move');
  if (select count(*) from budget_setups where workgroup_id = runs) <> 2 then
    raise exception 'A backfill added a restore row or replaced the first setup';
  end if;
  if (select amounts->0->>'amount' from budget_setups where workgroup_id = runs and starts_on = '2021-01-01') <> '100' then
    raise exception 'The first setup changed';
  end if;
  if (select reason from budget_changes where workgroup_id = runs and effective_on = '2020-06-01') <> 'Before the move' then
    raise exception 'The backfill reason is not in the history';
  end if;

  -- 2. And a backfill before the backfill.
  perform save_budget_setup(runs, pg_temp.rev(runs), 'monthly', 'monthly', '2020-01-01', pg_temp.ada('20'), 'admin', false, 'Even earlier');
  if not exists (select 1 from budget_plans p join budget_setups s on s.id = p.setup_id
      where s.workgroup_id = runs and s.starts_on = '2020-01-01' and p.starts_on = '2020-01-01') then
    raise exception 'A dated backfill wrote no plan';
  end if;

  -- 3. Switching the mode of a past period that has a setup stays refused.
  if not pg_temp.refused(runs, 'quarterly', 'quarterly', '2020-07-01', 'Reshape the past') then
    raise exception 'A past setup switch was accepted';
  end if;

  -- ...and a change in force before a later scheduled setup still does not displace it.
  perform save_budget_setup(runs, pg_temp.rev(runs), 'recurring', 'monthly', '2030-01-01', pg_temp.ada('200'), 'admin');
  if not pg_temp.refused(runs, 'recurring', 'monthly', '2029-01-01', null) then
    raise exception 'An earlier recurring change displaced a scheduled setup';
  end if;

  -- 4. A quarterly backfill must not cut a quarter short.
  perform save_budget_setup(mixed, 0, 'recurring', 'monthly', '2021-09-01', pg_temp.ada('10'), 'admin', false, 'Opening budget');
  if not pg_temp.refused(mixed, 'quarterly', 'quarterly', '2021-04-01', 'Quarterly before a September start') then
    raise exception 'A quarterly backfill ending mid-quarter was accepted';
  end if;
  perform save_budget_setup(mixed, pg_temp.rev(mixed), 'recurring', 'monthly', '2021-04-01', pg_temp.ada('5'), 'admin', false, 'Monthly is fine');
  perform save_budget_setup(quarterly, 0, 'quarterly', 'quarterly', '2021-04-01', pg_temp.ada('30'), 'admin', true, 'Opening budget');
  perform save_budget_setup(quarterly, pg_temp.rev(quarterly), 'recurring', 'quarterly', '2021-01-01', pg_temp.ada('25'), 'admin', false, 'Q1 before the move');
  if (select count(*) from budget_setups where workgroup_id = quarterly) <> 2 then
    raise exception 'A quarterly backfill ending on a quarter boundary was refused';
  end if;

  -- 5. An owner whose original budgets await review is not backfilled.
  if not pg_temp.refused(review, 'recurring', 'monthly', '2020-06-01', 'Before review') then
    raise exception 'A backfill skipped the legacy review';
  end if;
end $$;

rollback;
\echo Budget backfill tests passed.
