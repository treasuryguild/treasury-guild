-- Migration 0049: a native task inserted into its board's payable column is
-- payable. Run with psql -f against an EMPTY disposable PostgreSQL database;
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

insert into contributors(wallet_address) values ('admin'), ('lead');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'lead', 'member');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Runs', 'native');
insert into workgroup_leads(workgroup_id, wallet_address) values
  ('20000000-0000-0000-0000-000000000001', 'lead');
insert into board_columns(id, workgroup_id, name, position, marks_payable) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'To Do', 0, false),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Audited', 1, true);

-- A lead adds cards the way the board does (three granted columns).
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"lead"}', true);
insert into tasks(workgroup_id, title, column_id) values
  ('20000000-0000-0000-0000-000000000001', 'Typed into Audited', '50000000-0000-0000-0000-000000000002'),
  ('20000000-0000-0000-0000-000000000001', 'Typed into To Do', '50000000-0000-0000-0000-000000000001');
-- The browser still cannot choose the payment state itself.
select pg_temp.reject($$insert into tasks(workgroup_id, title, pay_state) values ('20000000-0000-0000-0000-000000000001', 'Sneaky', 'payable')$$, '42501');
reset role;

-- Server-side inserts keep what they chose.
insert into tasks(workgroup_id, source, title, pay_state, audited, column_id, paid_tx_hash) values
  ('20000000-0000-0000-0000-000000000001', 'native', 'Imported paid', 'paid', true, '50000000-0000-0000-0000-000000000002', 'aa');
insert into tasks(workgroup_id, source, title, column_id) values
  ('20000000-0000-0000-0000-000000000001', 'github', 'GitHub issue', '50000000-0000-0000-0000-000000000002');

do $$ begin
  if (select pay_state || '/' || audited from tasks where title = 'Typed into Audited') <> 'payable/true' then
    raise exception 'a task added to the payable column is not payable';
  end if;
  if (select pay_state || '/' || audited from tasks where title = 'Typed into To Do') <> 'none/false' then
    raise exception 'a task added to another column became payable';
  end if;
  if (select pay_state::text from tasks where title = 'Imported paid') <> 'paid' then
    raise exception 'a paid insert was rewritten';
  end if;
  if (select pay_state::text from tasks where title = 'GitHub issue') <> 'none' then
    raise exception 'a GitHub task was made payable by its column';
  end if;
end $$;

rollback;
\echo Task payable-on-insert tests passed.
