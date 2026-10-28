-- Head schema (migrations 0001-0065 + 0071-0072): what the browser may write on
-- tasks and workgroups, the task delete rules, the execute grants closed by
-- 0046, the governance Discord channel grants (0071) and treasury Discord
-- destination grants (0072). Run with psql -f against an EMPTY disposable
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
\ir ../migrations/0063_route_hardening.sql
\ir ../migrations/0064_agent_proposal_drafts.sql
\ir ../migrations/0065_agent_drafts.sql
\ir ../migrations/0071_governance_discord_channels.sql
\ir ../migrations/0072_treasury_discord_destinations.sql

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
-- "pay_state/audited" of a task, by title.
create function pg_temp.pay(task_title text) returns text language sql as
  $$ select pay_state || '/' || audited from tasks where title = task_title $$;

insert into contributors(wallet_address) values ('admin'), ('lead'), ('member');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'admin', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'lead', 'member'),
  ('10000000-0000-0000-0000-000000000000', 'member', 'member');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 1, 'addr_main', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Runs', 'native'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', 'Repo', 'github');
insert into workgroup_leads(workgroup_id, wallet_address) values
  ('20000000-0000-0000-0000-000000000001', 'lead'), ('20000000-0000-0000-0000-000000000002', 'lead');
insert into board_columns(id, workgroup_id, name, position, marks_payable, marks_paid) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'To Do', 0, false, false),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Audited', 1, true, false),
  ('50000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'Paid', 2, false, true),
  ('50000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000002', 'Audited', 0, true, false);

-- 1. task_payable_from_column (0049) on the head schema ---------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"lead"}', true);
-- The board's insert: three granted columns.
insert into tasks(workgroup_id, title, column_id) values
  ('20000000-0000-0000-0000-000000000001', 'Typed into Audited', '50000000-0000-0000-0000-000000000002'),
  ('20000000-0000-0000-0000-000000000001', 'Typed into To Do', '50000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000001', 'Typed into Paid', '50000000-0000-0000-0000-000000000003');
insert into tasks(workgroup_id, title) values ('20000000-0000-0000-0000-000000000001', 'No column');
-- The browser cannot choose the payment state, the source or the number itself.
select pg_temp.reject($$insert into tasks(workgroup_id, title, pay_state) values ('20000000-0000-0000-0000-000000000001', 'Sneaky', 'payable')$$, '42501');
select pg_temp.reject($$insert into tasks(workgroup_id, title, source) values ('20000000-0000-0000-0000-000000000002', 'Sneaky', 'github')$$, '42501');
select pg_temp.reject($$insert into tasks(workgroup_id, title, chain_number) values ('20000000-0000-0000-0000-000000000001', 'Sneaky', 7)$$, '42501');
-- A member who neither leads the workgroup nor administers the community adds nothing.
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
select pg_temp.reject($$insert into tasks(workgroup_id, title, column_id) values
  ('20000000-0000-0000-0000-000000000001', 'Member card', '50000000-0000-0000-0000-000000000002')$$, '42501');
reset role;

-- Server-side inserts keep what they chose; a native 'none' task follows its column there too.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into tasks(workgroup_id, source, title, pay_state, audited, column_id, paid_tx_hash) values
  ('20000000-0000-0000-0000-000000000001', 'native', 'Imported paid', 'paid', true, '50000000-0000-0000-0000-000000000002', 'aa');
insert into tasks(workgroup_id, source, title, column_id) values
  ('20000000-0000-0000-0000-000000000002', 'github', 'GitHub issue in Audited', '50000000-0000-0000-0000-000000000004'),
  ('20000000-0000-0000-0000-000000000001', 'native', 'Server card in Audited', '50000000-0000-0000-0000-000000000002'),
  ('20000000-0000-0000-0000-000000000001', 'native', 'Server card in To Do', '50000000-0000-0000-0000-000000000001');
reset role;

do $$ begin
  if pg_temp.pay('Typed into Audited') <> 'payable/true' then
    raise exception 'a task added to the payable column is not payable: %', pg_temp.pay('Typed into Audited');
  end if;
  if pg_temp.pay('Typed into To Do') <> 'none/false' or pg_temp.pay('Typed into Paid') <> 'none/false'
      or pg_temp.pay('No column') <> 'none/false' then
    raise exception 'a task outside the payable column became payable';
  end if;
  if pg_temp.pay('Imported paid') <> 'paid/true' then raise exception 'a paid insert was rewritten'; end if;
  if pg_temp.pay('GitHub issue in Audited') <> 'none/false' then raise exception 'a GitHub task was made payable by its column'; end if;
  if pg_temp.pay('Server card in Audited') <> 'payable/true' or pg_temp.pay('Server card in To Do') <> 'none/false' then
    raise exception 'server-side native inserts do not follow the column';
  end if;
  if exists (select 1 from tasks where title in ('Sneaky', 'Member card')) then raise exception 'a refused insert landed'; end if;
  -- Numbers are issued per community, in order, whoever inserts.
  if (select count(*) || '/' || min(number) || '/' || max(number) || '/' || count(distinct number) from tasks) <> '8/1/8/8' then
    raise exception 'task numbers wrong: %', (select string_agg(number::text, ',' order by number) from tasks);
  end if;
end $$;

-- 2. guard_task_client_write (0046) -------------------------------------------------------
insert into tasks(id, workgroup_id, source, title, amounts, bounty_lovelace, pay_state, audited, column_id) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'native', 'Open work', '{"ADA":"5"}', 5000000, 'payable', true, '50000000-0000-0000-0000-000000000002'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'native', 'Queued work', '{"ADA":"2"}', 2000000, 'payable', true, '50000000-0000-0000-0000-000000000002');
insert into tasks(id, workgroup_id, source, title, amounts, bounty_lovelace, pay_state, audited, paid_tx_hash, budget_month) values
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'native', 'Paid work', '{"ADA":"1"}', 1000000, 'paid', true, 'aa', '2026-08-01'),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 'native', 'Settled work', '{"ADA":"1"}', 1000000, 'reconciled', true, 'bb', '2026-08-01');
insert into tasks(id, workgroup_id, source, title, amounts, pay_state, audited) values
  ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000002', 'github', 'GitHub open', '{"ADA":"3"}', 'none', false),
  ('30000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000002', 'github', 'GitHub payable', '{"ADA":"3"}', 'payable', true);
-- 'Queued work' sits in a pending payout, the way build-payout leaves it.
insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state, submitted_at) values
  ('60000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'payout', '00', 'admin', 0, null),
  ('60000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'payout', '00', 'admin', 3, null),
  ('60000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001', 'payout', '00', 'admin', 2, now());
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount) values
  ('60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'member', 'lovelace', 2000000);
update tasks set pay_state = 'queued', budget_month = '2026-09-01' where id = '30000000-0000-0000-0000-000000000002';

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"lead"}', true);
-- A native task moves between none and payable, and is edited freely while outside a payout.
update tasks set pay_state = 'none', audited = false where id = '30000000-0000-0000-0000-000000000001';
update tasks set pay_state = 'payable', audited = true where id = '30000000-0000-0000-0000-000000000001';
update tasks set title = 'Open work, renamed', amounts = '{"ADA":"6"}', bounty_lovelace = 6000000, budget_month = '2026-09-01'
  where id = '30000000-0000-0000-0000-000000000001';
-- ...but never into or out of a payout state.
select pg_temp.reject($$update tasks set pay_state = 'queued' where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$update tasks set pay_state = 'paid' where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$update tasks set pay_state = 'reconciled' where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$update tasks set pay_state = 'payable' where id = '30000000-0000-0000-0000-000000000002'$$, '42501');
select pg_temp.reject($$update tasks set pay_state = 'none' where id = '30000000-0000-0000-0000-000000000002'$$, '42501');
select pg_temp.reject($$update tasks set pay_state = 'payable' where id = '30000000-0000-0000-0000-000000000003'$$, '42501');
select pg_temp.reject($$update tasks set pay_state = 'paid' where id = '30000000-0000-0000-0000-000000000004'$$, '42501');
-- A GitHub task's payment state follows its label, not the browser.
select pg_temp.reject($$update tasks set pay_state = 'payable' where id = '30000000-0000-0000-0000-000000000005'$$, '42501');
select pg_temp.reject($$update tasks set pay_state = 'none' where id = '30000000-0000-0000-0000-000000000006'$$, '42501');
-- A task in a payout (queued, paid, reconciled) keeps its amounts and budget period...
select pg_temp.reject($$update tasks set amounts = '{"ADA":"100"}' where id = '30000000-0000-0000-0000-000000000002'$$, '23514');
select pg_temp.reject($$update tasks set bounty_lovelace = 100000000 where id = '30000000-0000-0000-0000-000000000002'$$, '23514');
select pg_temp.reject($$update tasks set budget_month = '2026-10-01' where id = '30000000-0000-0000-0000-000000000002'$$, '23514');
select pg_temp.reject($$update tasks set budget_month = null where id = '30000000-0000-0000-0000-000000000002'$$, '23514');
select pg_temp.reject($$update tasks set amounts = '{"ADA":"100"}' where id = '30000000-0000-0000-0000-000000000003'$$, '23514');
select pg_temp.reject($$update tasks set budget_month = '2026-10-01' where id = '30000000-0000-0000-0000-000000000003'$$, '23514');
select pg_temp.reject($$update tasks set bounty_lovelace = null where id = '30000000-0000-0000-0000-000000000004'$$, '23514');
-- ...while its title still saves (Save title on an imported stub).
update tasks set title = 'Queued work, renamed' where id = '30000000-0000-0000-0000-000000000002';
update tasks set title = 'Paid work, renamed' where id = '30000000-0000-0000-0000-000000000003';
-- Columns the browser never writes are not granted.
select pg_temp.reject($$update tasks set paid_tx_hash = 'cc' where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$update tasks set source = 'github' where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$update tasks set archived_at = now() where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
select pg_temp.reject($$update tasks set number = 99 where id = '30000000-0000-0000-0000-000000000001'$$, '42501');
-- A plain member's update reaches no row.
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
update tasks set title = 'Member edit' where id = '30000000-0000-0000-0000-000000000001';
-- There is no delete policy: a browser delete removes nothing, even for the owner.
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
delete from tasks where id in ('30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000005');
reset role;

do $$ begin
  if (select pay_state || '|' || title || '|' || (amounts->>'ADA') || '|' || bounty_lovelace || '|' || budget_month
      from tasks where id = '30000000-0000-0000-0000-000000000001') <> 'payable|Open work, renamed|6|6000000|2026-09-01' then
    raise exception 'lead edits of the open task were not applied: %', (select to_jsonb(t) from tasks t where id = '30000000-0000-0000-0000-000000000001');
  end if;
  if (select pay_state || '|' || title || '|' || (amounts->>'ADA') || '|' || bounty_lovelace || '|' || budget_month
      from tasks where id = '30000000-0000-0000-0000-000000000002') <> 'queued|Queued work, renamed|2|2000000|2026-09-01' then
    raise exception 'the queued task changed beyond its title';
  end if;
  if (select pay_state || '|' || title || '|' || (amounts->>'ADA') || '|' || budget_month
      from tasks where id = '30000000-0000-0000-0000-000000000003') <> 'paid|Paid work, renamed|1|2026-08-01' then
    raise exception 'the paid task changed beyond its title';
  end if;
  if (select string_agg(pay_state::text, ',' order by id) from tasks where workgroup_id = '20000000-0000-0000-0000-000000000002'
      and id in ('30000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000006')) <> 'none,payable' then
    raise exception 'a GitHub task changed payment state or was deleted from the browser';
  end if;
end $$;

-- The service role (payout code, sync, import) is not held to the browser's rules.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update tasks set pay_state = 'queued' where id = '30000000-0000-0000-0000-000000000001';
update tasks set pay_state = 'payable' where id = '30000000-0000-0000-0000-000000000001';
update tasks set pay_state = 'payable', audited = true where id = '30000000-0000-0000-0000-000000000005';
update tasks set pay_state = 'none', audited = false where id = '30000000-0000-0000-0000-000000000005';
update tasks set budget_month = '2026-07-01' where id = '30000000-0000-0000-0000-000000000003';
reset role;

-- 3. guard_task_lifecycle delete rules (0021, 0041) --------------------------------------
-- Payment history: a rejected payout on an otherwise unpaid native task, a confirmed one on a GitHub task.
insert into tasks(id, workgroup_id, source, title, pay_state, audited) values
  ('30000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001', 'native', 'Once rejected', 'payable', true),
  ('30000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000001', 'native', 'Unwanted', 'none', false),
  ('30000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000001', 'native', 'Unwanted too', 'payable', true),
  ('30000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-000000000002', 'github', 'GitHub with a payout', 'payable', true),
  ('30000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-000000000002', 'github', 'GitHub paid', 'paid', true);
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount) values
  ('60000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000007', 'member', 'lovelace', 1),
  ('60000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-00000000000a', 'member', 'lovelace', 1);

-- Through the app: archive first, then delete with the exact title.
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"lead"}', true);
select pg_temp.reject($$select change_task_lifecycle('30000000-0000-0000-0000-000000000008', 'delete', 'Unwanted')$$, '23514');
select change_task_lifecycle('30000000-0000-0000-0000-000000000008', 'archive');
select pg_temp.reject($$select change_task_lifecycle('30000000-0000-0000-0000-000000000008', 'delete', 'unwanted')$$, '23514');
select change_task_lifecycle('30000000-0000-0000-0000-000000000008', 'delete', 'Unwanted');
-- A GitHub task is managed on GitHub; a queued task cannot be archived.
select pg_temp.reject($$select change_task_lifecycle('30000000-0000-0000-0000-000000000005', 'archive')$$, '23514');
select pg_temp.reject($$select change_task_lifecycle('30000000-0000-0000-0000-000000000002', 'archive')$$, '23514');
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"member"}', true);
select pg_temp.reject($$select change_task_lifecycle('30000000-0000-0000-0000-000000000009', 'archive')$$, '42501');
reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
-- Native: never while active, never with payment history, even for the service role.
select pg_temp.reject($$delete from tasks where id = '30000000-0000-0000-0000-000000000009'$$, '23514');
select pg_temp.reject($$delete from tasks where id = '30000000-0000-0000-0000-000000000002'$$, '23514');
select pg_temp.reject($$delete from tasks where id = '30000000-0000-0000-0000-000000000003'$$, '23514');
select pg_temp.reject($$delete from tasks where id = '30000000-0000-0000-0000-000000000004'$$, '23514');
update tasks set archived_at = now() where id in ('30000000-0000-0000-0000-000000000007', '30000000-0000-0000-0000-000000000009',
  '30000000-0000-0000-0000-000000000003');
-- Archived: a rejected payout row and a paid state still block; an unpaid one goes.
select pg_temp.reject($$delete from tasks where id = '30000000-0000-0000-0000-000000000007'$$, '23514');
select pg_temp.reject($$delete from tasks where id = '30000000-0000-0000-0000-000000000003'$$, '23514');
delete from tasks where id = '30000000-0000-0000-0000-000000000009';
-- An archived task is frozen, for the service role too.
select pg_temp.reject($$update tasks set title = 'Bypass' where id = '30000000-0000-0000-0000-000000000007'$$, '23514');
-- GitHub (0041): cannot be archived; the sync deletes an unpaid one directly, whatever its label says...
select pg_temp.reject($$update tasks set archived_at = now() where id = '30000000-0000-0000-0000-000000000005'$$, '23514');
delete from tasks where id in ('30000000-0000-0000-0000-000000000005', '30000000-0000-0000-0000-000000000006');
-- ...but not one with payout rows or a settled state.
select pg_temp.reject($$delete from tasks where id = '30000000-0000-0000-0000-00000000000a'$$, '23514');
select pg_temp.reject($$delete from tasks where id = '30000000-0000-0000-0000-00000000000b'$$, '23514');
reset role;

do $$ begin
  if (select string_agg(right(id::text, 1), '' order by id) from tasks where id::text like '30000000-0000-0000-0000-00000000000_') <> '12347ab' then
    raise exception 'wrong tasks survived the deletes: %',
      (select string_agg(right(id::text, 1), '' order by id) from tasks where id::text like '30000000-0000-0000-0000-00000000000_');
  end if;
  if (select count(*) from payouts) <> 3 then raise exception 'payment history lost'; end if;
  if (select string_agg(action, ',' order by occurred_at, action) from task_events where task_id = '30000000-0000-0000-0000-000000000008'
      and actor = 'lead') <> 'archive,delete' then
    raise exception 'lifecycle events missing';
  end if;
end $$;

-- 4. workgroups_insert (0056): admins create workgroups while the workgroup kind is off ----
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
insert into workgroups(community_id, name) values ('10000000-0000-0000-0000-000000000000', 'Direct, no settings');
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"lead"}', true);
select pg_temp.reject($$insert into workgroups(community_id, name) values ('10000000-0000-0000-0000-000000000000', 'By a lead')$$, '42501');
reset role;
-- A workgroup row that is switched off, and other kinds switched on, change nothing.
insert into governance_settings(community_id, kind, enabled, proposers, electorate, method, quorum_pct,
    threshold_pct, discussion_hours, voting_hours, updated_by) values
  ('10000000-0000-0000-0000-000000000000', 'workgroup', false, 'members', 'members', 'majority', 20, 50, 48, 120, 'admin'),
  ('10000000-0000-0000-0000-000000000000', 'budget', true, 'members', 'members', 'majority', 20, 50, 48, 120, 'admin'),
  ('10000000-0000-0000-0000-000000000000', 'task', true, 'members', 'members', 'majority', 20, 50, 48, 120, 'admin'),
  ('10000000-0000-0000-0000-000000000000', 'decision', true, 'members', 'members', 'majority', 20, 50, 48, 120, 'admin');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
insert into workgroups(community_id, name, description, kind) values
  ('10000000-0000-0000-0000-000000000000', 'Direct, kind off', 'Made by an admin', 'native');
-- Task proposals being on does not close the board either.
insert into tasks(workgroup_id, title, column_id) values
  ('20000000-0000-0000-0000-000000000001', 'Card while task proposals are on', '50000000-0000-0000-0000-000000000002');
reset role;
update governance_settings set enabled = true where kind = 'workgroup';
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
select pg_temp.reject($$insert into workgroups(community_id, name) values ('10000000-0000-0000-0000-000000000000', 'Direct, kind on')$$, '42501');
reset role;
-- The service role (chain import's create) is not held to the policy.
set local role service_role;
insert into workgroups(community_id, name) values ('10000000-0000-0000-0000-000000000000', 'Created by the import');
reset role;
do $$ begin
  if (select string_agg(name, ',' order by name) from workgroups where name like 'Direct%' or name like 'By a%' or name like 'Created%')
      <> 'Created by the import,Direct, kind off,Direct, no settings' then
    raise exception 'workgroups created wrongly: %', (select string_agg(name, ',' order by name) from workgroups);
  end if;
  if pg_temp.pay('Card while task proposals are on') <> 'payable/true' then raise exception 'board insert broken while task proposals are on'; end if;
end $$;

-- 5. Execute grants closed by 0046 ----------------------------------------------------------
-- This fixture grants EXECUTE to anon / authenticated / service_role by
-- default, as Supabase does, so these hold only because 0046 revokes them.
do $$
declare
  f text;
  r text;
begin
  foreach f in array array[
    'public.replace_workgroup_budgets(uuid, jsonb, text)',
    'public.replace_workgroup_period_budgets(uuid, jsonb, text, date)',
    'public.replace_workgroup_dated_budgets(uuid, jsonb, text, date, text)',
    'public.budget_setup_workspace(uuid)',
    'public.hit_rate_limit(text, integer, integer)'] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, f, 'execute') then raise exception '% may execute %', r, f; end if;
    end loop;
    if not has_function_privilege('service_role', f, 'execute') then raise exception 'service_role may not execute %', f; end if;
  end loop;
  -- The trigger functions are not callable either (they are not RPCs).
  foreach f in array array['public.guard_task_client_write()', 'public.task_payable_from_column()'] loop
    if has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute') then
      raise exception 'a browser role may execute %', f;
    end if;
  end loop;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
select pg_temp.reject($$select public.replace_workgroup_budgets('20000000-0000-0000-0000-000000000001', '[]', 'admin')$$, '42501');
select pg_temp.reject($$select public.replace_workgroup_period_budgets('20000000-0000-0000-0000-000000000001', '[]', 'admin', '2026-09-01')$$, '42501');
select pg_temp.reject($$select public.replace_workgroup_dated_budgets('20000000-0000-0000-0000-000000000001', '[]', 'admin', '2026-10-01', 'quarterly')$$, '42501');
select pg_temp.reject($$select public.budget_setup_workspace('10000000-0000-0000-0000-000000000000')$$, '42501');
select pg_temp.reject($$select public.hit_rate_limit('x', 1, 60)$$, '42501');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.reject($$select public.replace_workgroup_budgets('20000000-0000-0000-0000-000000000001', '[]', 'admin')$$, '42501');
select pg_temp.reject($$select public.replace_workgroup_period_budgets('20000000-0000-0000-0000-000000000001', '[]', 'admin', '2026-09-01')$$, '42501');
select pg_temp.reject($$select public.replace_workgroup_dated_budgets('20000000-0000-0000-0000-000000000001', '[]', 'admin', '2026-10-01', 'quarterly')$$, '42501');
select pg_temp.reject($$select * from contributors$$, '42501');
reset role;

-- 6. governance_discord_channels (0071): channel config is service-role only ------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into governance_discord_channels(community_id, channel_id, channel_type, created_by)
  values ('10000000-0000-0000-0000-000000000000', '123456789012345678', 15, 'admin');
update governance_discord_channels set last_posted_at = now(), last_error = null
  where community_id = '10000000-0000-0000-0000-000000000000';
do $$ begin
  if (select channel_id from governance_discord_channels where last_posted_at is not null) <> '123456789012345678' then
    raise exception 'the service role cannot read or update the governance channel';
  end if;
end $$;
reset role;
do $$
declare r text; p text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if has_table_privilege(r, 'public.governance_discord_channels', p) then
        raise exception '% holds % on governance_discord_channels', r, p;
      end if;
    end loop;
    if has_any_column_privilege(r, 'public.governance_discord_channels', 'select, insert, update') then
      raise exception '% holds a column privilege on governance_discord_channels', r;
    end if;
  end loop;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
select pg_temp.reject($$select * from governance_discord_channels$$, '42501');
select pg_temp.reject($$select count(*) from governance_discord_channels$$, '42501');
select pg_temp.reject($$insert into governance_discord_channels(community_id, channel_id, channel_type, created_by)
  values ('10000000-0000-0000-0000-000000000000', '999', 0, 'admin')$$, '42501');
select pg_temp.reject($$update governance_discord_channels set channel_id = '999'$$, '42501');
select pg_temp.reject($$delete from governance_discord_channels$$, '42501');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.reject($$select * from governance_discord_channels$$, '42501');
select pg_temp.reject($$insert into governance_discord_channels(community_id, channel_id, channel_type, created_by)
  values ('10000000-0000-0000-0000-000000000000', '999', 0, 'anon')$$, '42501');
select pg_temp.reject($$update governance_discord_channels set channel_id = '999'$$, '42501');
select pg_temp.reject($$delete from governance_discord_channels$$, '42501');
reset role;
set local role service_role;
delete from governance_discord_channels where community_id = '10000000-0000-0000-0000-000000000000';
do $$ begin
  if exists (select 1 from governance_discord_channels) then raise exception 'the service role cannot delete the channel'; end if;
end $$;
reset role;

-- 7. treasury_discord_destinations (0072): XOR mode + service-role only --------------
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into treasury_discord_destinations(treasury_id, url, created_by)
  values ('40000000-0000-0000-0000-000000000001', 'https://discord.com/api/webhooks/1/tok', 'admin');
update treasury_discord_destinations
  set url = null, channel_id = '123456789012345678', channel_type = 0, last_posted_at = now(), last_error = null
  where treasury_id = '40000000-0000-0000-0000-000000000001';
do $$ begin
  if (select channel_id from treasury_discord_destinations where last_posted_at is not null) <> '123456789012345678' then
    raise exception 'the service role cannot read or update the treasury destination';
  end if;
end $$;
-- XOR: both modes set, neither set, channel without type, forum type.
delete from treasury_discord_destinations where treasury_id = '40000000-0000-0000-0000-000000000001';
select pg_temp.reject($$insert into treasury_discord_destinations(treasury_id, url, channel_id, channel_type, created_by)
  values ('40000000-0000-0000-0000-000000000001', 'https://discord.com/api/webhooks/2/tok', '9', 0, 'admin')$$, '23514');
select pg_temp.reject($$insert into treasury_discord_destinations(treasury_id, created_by)
  values ('40000000-0000-0000-0000-000000000001', 'admin')$$, '23514');
select pg_temp.reject($$insert into treasury_discord_destinations(treasury_id, channel_id, created_by)
  values ('40000000-0000-0000-0000-000000000001', '9', 'admin')$$, '23514');
select pg_temp.reject($$insert into treasury_discord_destinations(treasury_id, channel_id, channel_type, created_by)
  values ('40000000-0000-0000-0000-000000000001', '9', 15, 'admin')$$, '23514');
reset role;
do $$
declare r text; p text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if has_table_privilege(r, 'public.treasury_discord_destinations', p) then
        raise exception '% holds % on treasury_discord_destinations', r, p;
      end if;
    end loop;
    if has_any_column_privilege(r, 'public.treasury_discord_destinations', 'select, insert, update') then
      raise exception '% holds a column privilege on treasury_discord_destinations', r;
    end if;
  end loop;
end $$;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","wallet":"admin"}', true);
select pg_temp.reject($$select * from treasury_discord_destinations$$, '42501');
select pg_temp.reject($$insert into treasury_discord_destinations(treasury_id, url, created_by)
  values ('40000000-0000-0000-0000-000000000001', 'https://discord.com/api/webhooks/9/tok', 'admin')$$, '42501');
select pg_temp.reject($$update treasury_discord_destinations set last_error = 'x'$$, '42501');
select pg_temp.reject($$delete from treasury_discord_destinations$$, '42501');
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.reject($$select * from treasury_discord_destinations$$, '42501');
select pg_temp.reject($$insert into treasury_discord_destinations(treasury_id, url, created_by)
  values ('40000000-0000-0000-0000-000000000001', 'https://discord.com/api/webhooks/9/tok', 'anon')$$, '42501');
reset role;

rollback;
\echo Head task guard tests passed.
