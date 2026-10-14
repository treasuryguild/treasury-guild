-- Migration 0035: dated workgroup wallet routing. Run with psql -f against an
-- EMPTY disposable PostgreSQL database; everything is rolled back.
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

create function pg_temp.reject(command text, expected_state text) returns void language plpgsql as $$
begin
  begin execute command;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Expected % from: %', expected_state, command;
end $$;

insert into contributors(wallet_address) values ('admin'), ('member');
insert into communities(id, slug, name, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 'admin'),
  ('10000000-0000-0000-0000-000000000002', 'other', 'Other', 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'admin'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Dev', 0, 1, 'addr_dev', '00'),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'Elsewhere', 0, 1, 'addr_other', '00');
-- routed: paid from Main this period. quarterly: quarterly setup, no payouts.
-- free: any wallet. archived: frozen.
insert into workgroups(id, community_id, name, treasury_id) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Routed', '40000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Quarterly', null),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000', 'Free', null),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000000', 'Archived', '40000000-0000-0000-0000-000000000001');
insert into budget_setups(workgroup_id, starts_on, mode, cadence) values
  ('20000000-0000-0000-0000-000000000002', '2000-01-01', 'recurring', 'quarterly');
insert into tasks(id, workgroup_id, title, pay_state, budget_month) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Paid this period', 'paid',
    date_trunc('month', now() at time zone 'UTC')::date);
insert into transactions(id, treasury_id, tx_cbor, created_by, state) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', '00', 'admin', 2);
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount) values
  ('50000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'admin', 'lovelace', 100);
update workgroups set archived_at = now() where id = '20000000-0000-0000-0000-000000000004';

\ir ../migrations/0035_workgroup_treasury_assignments.sql

set local role service_role;
do $$
declare
  routed uuid := '20000000-0000-0000-0000-000000000001';
  quarterly uuid := '20000000-0000-0000-0000-000000000002';
  free uuid := '20000000-0000-0000-0000-000000000003';
  archived uuid := '20000000-0000-0000-0000-000000000004';
  main uuid := '40000000-0000-0000-0000-000000000001';
  dev uuid := '40000000-0000-0000-0000-000000000002';
  elsewhere uuid := '40000000-0000-0000-0000-000000000003';
  month_start date := date_trunc('month', now() at time zone 'UTC')::date;
  quarter_start date := date_trunc('quarter', now() at time zone 'UTC')::date;
  effective date;
  s jsonb;
begin
  -- Backfill: one timeline row per routed workgroup, none for "any wallet".
  if (select count(*) from workgroup_treasury_assignments) <> 2
    or not exists (select 1 from workgroup_treasury_assignments where workgroup_id = routed
      and treasury_id = main and starts_on = date '1000-01-01' and created_by = 'migration') then
    raise exception 'Existing routings not backfilled';
  end if;

  perform pg_temp.reject(format('select set_workgroup_treasury(%L,%L,%L,%L)', routed, dev, 'next', 'member'), '42501');
  perform pg_temp.reject(format('select set_workgroup_treasury(%L,%L,%L,%L)', '20000000-0000-0000-0000-000000000009', dev, 'next', 'admin'), 'P0002');
  perform pg_temp.reject(format('select set_workgroup_treasury(%L,%L,%L,%L)', routed, elsewhere, 'next', 'admin'), '23514');
  perform pg_temp.reject(format('select set_workgroup_treasury(%L,%L,%L,%L)', routed, dev, 'someday', 'admin'), '23514');
  perform pg_temp.reject(format('select set_workgroup_treasury(%L,%L,%L,%L)', archived, dev, 'next', 'admin'), '23514');

  -- This period already paid from Main: switching now is refused, next period is scheduled.
  s := workgroup_treasury_routing(routed);
  if not (s->>'currentBlocked')::boolean or (s->>'currentStart')::date <> month_start then
    raise exception 'Routing status must report the paid period';
  end if;
  perform pg_temp.reject(format('select set_workgroup_treasury(%L,%L,%L,%L)', routed, dev, 'current', 'admin'), '23514');
  perform pg_temp.reject(format('select set_workgroup_treasury(%L,%L,%L,%L)', routed, null, 'current', 'admin'), '23514');
  -- Re-affirming the wallet already used this period is allowed.
  if set_workgroup_treasury(routed, main, 'current', 'admin') <> month_start then
    raise exception 'Same-wallet change this period should be accepted';
  end if;
  effective := set_workgroup_treasury(routed, dev, 'next', 'admin', 'New dev wallet');
  if effective <> (month_start + interval '1 month')::date then raise exception 'Next period must be next month'; end if;
  if (select treasury_id from workgroups where id = routed) <> main then
    raise exception 'A scheduled change must not take effect early';
  end if;
  -- An earlier change is blocked by the scheduled one; the same date replaces it.
  perform pg_temp.reject(format('select set_workgroup_treasury(%L,%L,%L,%L)', routed, main, 'current', 'admin'), '23514');
  perform set_workgroup_treasury(routed, main, 'next', 'admin', 'Cancelled');
  if (select treasury_id from workgroup_treasury_assignments where workgroup_id = routed and starts_on = effective) <> main
    or (select count(*) from workgroup_treasury_assignments where workgroup_id = routed) <> 3 then
    raise exception 'Same-date change must replace the scheduled row';
  end if;
  if apply_workgroup_treasury_assignments() <> 0 then raise exception 'Nothing is due yet'; end if;

  -- A quarterly workgroup switches at quarter boundaries; nothing paid, so now is fine.
  if set_workgroup_treasury(quarterly, dev, 'current', 'admin') <> quarter_start then
    raise exception 'Quarterly workgroup must align to the quarter';
  end if;
  if (select treasury_id from workgroups where id = quarterly) <> dev then
    raise exception 'A change for the current period takes effect at once';
  end if;
  if set_workgroup_treasury(quarterly, null, 'next', 'admin') <> (quarter_start + interval '3 months')::date then
    raise exception 'Next quarter expected';
  end if;
  s := workgroup_treasury_routing(quarterly);
  if s->>'cadence' <> 'quarterly' or jsonb_array_length(s->'history') <> 2 then
    raise exception 'Routing status must list the history';
  end if;

  -- A due row is applied by the sweep; an archived workgroup stays frozen.
  insert into workgroup_treasury_assignments(workgroup_id, treasury_id, starts_on, created_by)
    values (free, main, (month_start - interval '1 month')::date, 'admin'),
           (archived, dev, (month_start - interval '1 month')::date, 'admin');
  if apply_workgroup_treasury_assignments() <> 1 then raise exception 'One due routing expected'; end if;
  if (select treasury_id from workgroups where id = free) <> main
    or (select treasury_id from workgroups where id = archived) <> main then
    raise exception 'Sweep must apply due routings to active workgroups only';
  end if;
end $$;
reset role;

select set_config('request.jwt.claims','{"wallet":"admin"}',true);
set local role authenticated;
do $$
begin
  perform pg_temp.reject('update workgroups set treasury_id = null', '42501');
  perform pg_temp.reject('insert into workgroups(community_id, name, treasury_id) values (''10000000-0000-0000-0000-000000000000'', ''x'', ''40000000-0000-0000-0000-000000000001'')', '42501');
  perform pg_temp.reject('select set_workgroup_treasury(''20000000-0000-0000-0000-000000000003'', null, ''next'', ''admin'')', '42501');
  perform pg_temp.reject('insert into workgroup_treasury_assignments(workgroup_id, starts_on, created_by) values (''20000000-0000-0000-0000-000000000003'', ''2030-01-01'', ''admin'')', '42501');
  update workgroups set description = 'Still editable' where id = '20000000-0000-0000-0000-000000000003';
  if (select count(*) from workgroup_treasury_assignments) < 3 then raise exception 'Members must read the history'; end if;
end $$;
reset role;

rollback;
\echo Workgroup treasury routing tests passed.
