-- Migration 0074: archiving a treasury keeps its row, address and transactions.
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
\ir ../migrations/0063_route_hardening.sql
\ir ../migrations/0064_agent_proposal_drafts.sql
\ir ../migrations/0065_agent_drafts.sql
\ir ../migrations/0066_github_multi_install.sql
\ir ../migrations/0067_github_document_store.sql
\ir ../migrations/0068_proposal_replaces.sql
\ir ../migrations/0069_primary_treasury.sql
\ir ../migrations/0070_anchor_alerts.sql
\ir ../migrations/0071_governance_discord_channels.sql
\ir ../migrations/0072_treasury_discord_destinations.sql
\ir ../migrations/0073_community_invites.sql
\ir ../migrations/0074_treasury_lifecycle.sql

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

set local role authenticated;
select pg_temp.reject($$select change_treasury_lifecycle('40000000-0000-4000-8000-000000000002', 'archive', 'admin')$$, '42501');
select pg_temp.reject($$select treasury_lifecycle_status('40000000-0000-4000-8000-000000000002')$$, '42501');
reset role;

set local role service_role;

insert into contributors(wallet_address) values ('admin'), ('member');
insert into communities(id, slug, name, network, created_by)
  values ('10000000-0000-4000-8000-000000000001', 'demo', 'Demo', 0, 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-4000-8000-000000000001', 'admin', 'admin'),
  ('10000000-0000-4000-8000-000000000001', 'member', 'member');
insert into workgroups(id, community_id, name)
  values ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Design');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Main', 0, 1, 'addr-main', '00'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Ops', 0, 1, 'addr-ops', '01'),
  ('40000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Spare', 0, 1, 'addr-spare', '02');

do $$
declare
  community uuid := '10000000-0000-4000-8000-000000000001';
  main uuid := '40000000-0000-4000-8000-000000000001';
  ops uuid := '40000000-0000-4000-8000-000000000002';
  spare uuid := '40000000-0000-4000-8000-000000000003';
  design uuid := '20000000-0000-4000-8000-000000000001';
  amounts jsonb := '[{"unit":"lovelace","amount":"200","asset_label":"ADA","decimals":6}]';
  month date := date_trunc('month', now() at time zone 'UTC')::date;
  stamped timestamptz;
  s jsonb;
  r integer;
begin
  perform pg_temp.reject(format('select change_treasury_lifecycle(%L, %L, %L)', ops, 'archive', 'member'), '42501');
  perform pg_temp.reject(format('select change_treasury_lifecycle(%L, %L, %L)', ops, 'nope', 'admin'), '23514');
  perform pg_temp.reject(format('select change_treasury_lifecycle(%L, %L, %L)', gen_random_uuid(), 'archive', 'admin'), 'P0002');

  update communities set primary_treasury_id = main where id = community;
  perform pg_temp.reject(format('select change_treasury_lifecycle(%L, %L, %L)', main, 'archive', 'admin'), '23514');
  perform pg_temp.reject(format('update treasuries set archived_at = now(), archived_by = %L where id = %L', 'admin', main), '23514');

  insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state)
    values ('50000000-0000-4000-8000-000000000001', ops, 'anchor', 'c0', 'admin', 0);
  perform pg_temp.reject(format('select change_treasury_lifecycle(%L, %L, %L)', ops, 'archive', 'admin'), '23514');
  update transactions set state = 1 where treasury_id = ops;
  perform pg_temp.reject(format('select change_treasury_lifecycle(%L, %L, %L)', ops, 'archive', 'admin'), '23514');
  update transactions set state = 2 where treasury_id = ops;

  perform set_workgroup_treasury(design, ops, 'current', 'admin');
  s := treasury_lifecycle_status(ops);
  if not exists (
    select 1 from jsonb_array_elements_text(s->'blockers') b where b like '%Design%'
  ) then
    raise exception 'Routing blocker missing: %', s;
  end if;
  perform pg_temp.reject(format('select change_treasury_lifecycle(%L, %L, %L)', ops, 'archive', 'admin'), '23514');
  perform set_workgroup_treasury(design, main, 'current', 'admin');
  perform set_workgroup_treasury(design, ops, 'next', 'admin');
  perform pg_temp.reject(format('select change_treasury_lifecycle(%L, %L, %L)', ops, 'archive', 'admin'), '23514');
  perform set_workgroup_treasury(design, null, 'next', 'admin');

  perform save_budget_setup(null, 0, 'recurring', 'monthly', month, amounts, 'admin', false, null, ops);
  perform change_treasury_lifecycle(ops, 'archive', 'admin');
  stamped := (select archived_at from treasuries where id = ops);
  if stamped is null or (select archived_by from treasuries where id = ops) <> 'admin' then
    raise exception 'Archive did not stamp the row';
  end if;
  perform change_treasury_lifecycle(ops, 'archive', 'admin');
  if (select archived_at from treasuries where id = ops) is distinct from stamped then
    raise exception 'Archive is not idempotent';
  end if;
  if (select count(*) from transactions where treasury_id = ops) <> 1 then
    raise exception 'Archiving dropped the treasury transaction';
  end if;

  perform pg_temp.reject(format('select save_budget_setup(null, 1, ''recurring'', ''monthly'', ''2031-01-01'', %L, ''admin'', false, null, %L)', amounts, ops), '23514');
  perform pg_temp.reject(format('select set_workgroup_treasury(%L, %L, %L, %L)', design, ops, 'next', 'admin'), '23514');
  perform pg_temp.reject(format('update treasuries set name = %L where id = %L', 'Renamed', ops), '23514');
  perform pg_temp.reject(format('update communities set primary_treasury_id = %L where id = %L', ops, community), '23514');
  perform pg_temp.reject(format('delete from treasuries where id = %L', ops), '23514');

  perform change_treasury_lifecycle(ops, 'restore', 'admin');
  if (select archived_at from treasuries where id = ops) is not null
     or (select archived_by from treasuries where id = ops) is not null then
    raise exception 'Restore did not clear the archive';
  end if;
  perform change_treasury_lifecycle(ops, 'restore', 'admin');
  r := save_budget_setup(null, 1, 'recurring', 'monthly', '2031-01-01', amounts, 'admin', false, null, ops);
  if r <> 2 then raise exception 'Budget save after restore returned %', r; end if;
  update treasuries set name = 'Ops again' where id = ops;

  delete from treasuries where id = spare;
  if exists (select 1 from treasuries where id = spare) then
    raise exception 'A treasury with no transactions should still delete';
  end if;
end $$;

rollback;

