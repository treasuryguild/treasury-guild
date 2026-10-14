-- Head schema (migrations 0001-0063): the route hardening of 0063. Several
-- open login challenges per address, the call reward / delete / finalize
-- checked under the call row lock, replace_task_assignees in one step and
-- save_call_integration saving a host connection with its tokens. Run with
-- psql -f against an EMPTY disposable PostgreSQL database; everything is
-- rolled back.
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

insert into contributors(wallet_address) values ('alice'), ('bob'), ('carol'), ('dave');
insert into communities(id, slug, name, network, created_by) values
  ('10000000-0000-0000-0000-000000000000', 'guild', 'Guild', 0, 'alice'),
  ('10000000-0000-0000-0000-000000000009', 'other', 'Other', 0, 'alice');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000000', 'alice', 'owner'),
  ('10000000-0000-0000-0000-000000000000', 'bob', 'member');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Main', 0, 2, 'addr_main', '00');
insert into workgroups(id, community_id, name, kind) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', 'Runs', 'native');

-- 1. Only the service role may call the new functions -------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.set_call_amounts(uuid, jsonb)',
    'public.delete_call_without_tasks(uuid)',
    'public.finalize_call_at_reward(uuid, text, uuid[], integer, bigint, jsonb)',
    'public.replace_task_assignees(uuid, jsonb)',
    'public.save_call_integration(uuid, text, text, text, text, text, text, timestamptz)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'a browser role may execute %', f;
    end if;
    if not has_function_privilege('service_role', f, 'execute') then raise exception 'service_role may not execute %', f; end if;
  end loop;
end $$;

-- 2. Login challenges: several open per address, one consumed at a time ---------------------
insert into auth_nonces(address, nonce, expires_at) values
  ('addr_victim', 'challenge the owner is signing', now() + interval '5 minutes'),
  -- Someone else asking for the same address adds a challenge, never replaces one.
  ('addr_victim', 'challenge someone else asked for', now() + interval '5 minutes'),
  ('addr_victim', 'expired challenge', now() - interval '1 minute');
do $$ begin
  if (select count(*) from auth_nonces where address = 'addr_victim') <> 3 then
    raise exception 'a new challenge replaced an open one';
  end if;
  if not exists (select 1 from auth_nonces where address = 'addr_victim' and nonce = 'challenge the owner is signing') then
    raise exception 'the owner''s challenge is gone';
  end if;
end $$;
select pg_temp.reject($$insert into auth_nonces(address, nonce) values ('addr_other', 'challenge the owner is signing')$$, '23505');
-- What purgeExpiredNonces runs.
delete from auth_nonces where expires_at < now();
do $$ begin
  if (select count(*) from auth_nonces where address = 'addr_victim') <> 2 then raise exception 'purge removed the wrong challenges'; end if;
end $$;

-- 3. Calls: reward, delete and finalize under the call's row lock ---------------------------
insert into calls(id, community_id, workgroup_id, provider, title, starts_at, ends_at, amounts, created_by) values
  ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001',
   'manual', 'Town hall', '2026-10-01 18:00Z', '2026-10-01 19:00Z', '{"ADA":"5"}', 'alice'),
  ('70000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001',
   'manual', 'Never held', '2026-10-02 18:00Z', '2026-10-02 19:00Z', '{"ADA":"5"}', 'alice');
insert into call_attendees(id, call_id, provider, display_name, wallet_address, status) values
  ('71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'manual', 'Bob', 'bob', 'confirmed');

-- No tasks yet: the reward can change.
select set_call_amounts('70000000-0000-0000-0000-000000000001', '{"ADA":"7"}');
do $$ begin
  if (select amounts from calls where id = '70000000-0000-0000-0000-000000000001') <> '{"ADA":"7"}' then
    raise exception 'set_call_amounts did not write';
  end if;
end $$;
-- Finalize with the reward the route read before that change: refused, nothing created.
select pg_temp.reject($$select finalize_call_at_reward('70000000-0000-0000-0000-000000000001', 'alice',
  array['71000000-0000-0000-0000-000000000001']::uuid[], 20, 5000000, '{"ADA":"5"}')$$, '23514');
do $$ begin
  if exists (select 1 from call_tasks where call_id = '70000000-0000-0000-0000-000000000001') then
    raise exception 'a refused finalize created a task';
  end if;
end $$;
-- With the current reward: one task whose amounts and bounty agree.
select finalize_call_at_reward('70000000-0000-0000-0000-000000000001', 'alice',
  array['71000000-0000-0000-0000-000000000001']::uuid[], 20, 7000000, '{"ADA":"7"}');
do $$ begin
  if (select count(*) from call_tasks where call_id = '70000000-0000-0000-0000-000000000001') <> 1
      or (select t.amounts::text || '|' || t.bounty_lovelace from tasks t join call_tasks c on c.task_id = t.id
          where c.call_id = '70000000-0000-0000-0000-000000000001') <> '{"ADA": "7"}|7000000' then
    raise exception 'finalize_call_at_reward did not create the expected task';
  end if;
end $$;
-- Now the reward is locked and the call stays as the task's record.
select pg_temp.reject($$select set_call_amounts('70000000-0000-0000-0000-000000000001', '{"ADA":"9"}')$$, '23514');
select pg_temp.reject($$select delete_call_without_tasks('70000000-0000-0000-0000-000000000001')$$, '23514');
select pg_temp.reject($$select set_call_amounts('70000000-0000-0000-0000-0000000000ff', '{"ADA":"9"}')$$, 'P0002');
select pg_temp.reject($$select delete_call_without_tasks('70000000-0000-0000-0000-0000000000ff')$$, 'P0002');
select pg_temp.reject($$select finalize_call_at_reward('70000000-0000-0000-0000-0000000000ff', 'alice',
  array[]::uuid[], 20, 7000000, '{"ADA":"7"}')$$, 'P0002');
-- A call without tasks is deleted.
select delete_call_without_tasks('70000000-0000-0000-0000-000000000002');
do $$ begin
  if (select amounts from calls where id = '70000000-0000-0000-0000-000000000001') <> '{"ADA":"7"}'
      or exists (select 1 from calls where id = '70000000-0000-0000-0000-000000000002') then
    raise exception 'the call rows are not as expected';
  end if;
end $$;

-- 4. Task assignees: one step, under the task lock, refused once settled --------------------
insert into tasks(id, workgroup_id, source, title, pay_state, audited) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'native', 'Editable', 'payable', true),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'native', 'Queued', 'queued', true),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'native', 'In a pending payout', 'payable', true),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 'native', 'In a rejected payout', 'payable', true),
  ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001', 'native', 'Paid', 'paid', true),
  ('30000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000001', 'native', 'Reconciled', 'reconciled', true),
  ('30000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001', 'native', 'In a submitted payout', 'payable', true),
  ('30000000-0000-0000-0000-000000000008', '20000000-0000-0000-0000-000000000001', 'native', 'In a confirmed payout', 'payable', true);
insert into task_assignees(id, task_id, source, gh_login, wallet_address, position) values
  ('80000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'github', 'octocat', 'alice', 0),
  ('80000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'github', 'hubot', 'bob', 1),
  ('80000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', 'manual', null, 'carol', 2),
  ('80000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000002', 'manual', null, 'carol', 0);
-- The two github rows swap wallets (the one-wallet-per-task index must not trip),
-- the manual row is replaced by dave, listed first.
select replace_task_assignees('30000000-0000-0000-0000-000000000001', $$[
  {"source": "manual", "wallet": "dave"},
  {"source": "github", "id": "80000000-0000-0000-0000-000000000001", "wallet": "bob"},
  {"source": "github", "id": "80000000-0000-0000-0000-000000000002", "wallet": "alice"}
]$$);
do $$ begin
  if (select string_agg(source || ':' || coalesce(gh_login, '-') || ':' || wallet_address || ':' || position, ',' order by position)
      from task_assignees where task_id = '30000000-0000-0000-0000-000000000001')
      <> 'manual:-:dave:0,github:octocat:bob:1,github:hubot:alice:2' then
    raise exception 'replace_task_assignees wrote %', (select string_agg(gh_login || wallet_address, ',') from task_assignees
      where task_id = '30000000-0000-0000-0000-000000000001');
  end if;
end $$;
-- A github row may be cleared; a failed write (dave twice) changes nothing.
select pg_temp.reject($$select replace_task_assignees('30000000-0000-0000-0000-000000000001', '[
  {"source": "manual", "wallet": "dave"}, {"source": "manual", "wallet": "dave"},
  {"source": "github", "id": "80000000-0000-0000-0000-000000000001", "wallet": null},
  {"source": "github", "id": "80000000-0000-0000-0000-000000000002", "wallet": null}]')$$, '23505');
do $$ begin
  if (select count(*) from task_assignees where task_id = '30000000-0000-0000-0000-000000000001') <> 3
      or not exists (select 1 from task_assignees where task_id = '30000000-0000-0000-0000-000000000001' and wallet_address = 'dave') then
    raise exception 'a failed replace left a half-written set';
  end if;
end $$;
-- Settled: queued, paid, reconciled, or in a live (pending, submitted, confirmed) payout.
-- A rejected payout does not lock it.
insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state) values
  ('60000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'payout', 'p0', 'hash-p', 'alice', 0),
  ('60000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'payout', 'r0', 'hash-r', 'alice', 3),
  ('60000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001', 'payout', 's0', 'hash-s', 'alice', 1),
  ('60000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000001', 'payout', 'c0', 'hash-c', 'alice', 2);
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount, status) values
  ('60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'bob', 'lovelace', 1000000, 'pending'),
  ('60000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000004', 'bob', 'lovelace', 1000000, 'pending'),
  ('60000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000007', 'bob', 'lovelace', 1000000, 'pending'),
  ('60000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000008', 'bob', 'lovelace', 1000000, 'pending');
do $$
declare
  t text;
begin
  foreach t in array array['002', '003', '005', '006', '007', '008'] loop
    perform pg_temp.reject(format($q$select replace_task_assignees('30000000-0000-0000-0000-000000000%s', '[{"source": "manual", "wallet": "dave"}]')$q$, t), '23514');
  end loop;
end $$;
select pg_temp.reject($$select replace_task_assignees('30000000-0000-0000-0000-0000000000ff', '[]')$$, 'P0002');
select replace_task_assignees('30000000-0000-0000-0000-000000000004', '[{"source": "manual", "wallet": "dave"}]');
do $$ begin
  if (select wallet_address from task_assignees where task_id = '30000000-0000-0000-0000-000000000002') <> 'carol'
      or (select wallet_address from task_assignees where task_id = '30000000-0000-0000-0000-000000000004') <> 'dave' then
    raise exception 'settled tasks changed, or a task of a rejected payout did not';
  end if;
end $$;

-- 5. Host connections: the row and its tokens in one step -----------------------------------
select save_call_integration('10000000-0000-0000-0000-000000000000', 'zoom', 'zoom-acc-1', 'Host', 'alice',
  'access-1', 'refresh-1', '2026-10-01 13:00Z');
do $$ begin
  if (select i.external_account_id || '|' || s.refresh_token from call_integrations i
      join call_integration_secrets s on s.integration_id = i.id
      where i.community_id = '10000000-0000-0000-0000-000000000000' and i.provider = 'zoom') <> 'zoom-acc-1|refresh-1' then
    raise exception 'save_call_integration did not save the row with its tokens';
  end if;
end $$;
-- Re-pointed to another account: same row, the new account's tokens.
select save_call_integration('10000000-0000-0000-0000-000000000000', 'zoom', 'zoom-acc-2', 'Other host', 'alice',
  'access-2', 'refresh-2', '2026-10-01 14:00Z');
do $$ begin
  if (select count(*) from call_integrations where provider = 'zoom') <> 1
      or (select i.external_account_id || '|' || s.refresh_token from call_integrations i
          join call_integration_secrets s on s.integration_id = i.id where i.provider = 'zoom') <> 'zoom-acc-2|refresh-2' then
    raise exception 're-pointing kept the old account''s tokens';
  end if;
end $$;
-- Without tokens (Discord), any stored ones are dropped; a refused write saves neither part.
select save_call_integration('10000000-0000-0000-0000-000000000000', 'zoom', 'zoom-acc-3', null, 'alice', null, null, null);
select pg_temp.reject($$select save_call_integration('10000000-0000-0000-0000-000000000000', 'skype', 'x', null, 'alice',
  'a', 'r', now())$$, '23514');
do $$ begin
  if exists (select 1 from call_integration_secrets s join call_integrations i on i.id = s.integration_id where i.provider = 'zoom')
      or (select external_account_id from call_integrations where provider = 'zoom') <> 'zoom-acc-3' then
    raise exception 'tokens survived a save without tokens';
  end if;
end $$;
-- A Discord server is saved without tokens from the start.
select save_call_integration('10000000-0000-0000-0000-000000000000', 'discord', 'guild-1', 'Signius HQ', 'alice', null, null, null);
do $$ begin
  if (select external_account_id from call_integrations where provider = 'discord') <> 'guild-1'
      or exists (select 1 from call_integration_secrets s join call_integrations i on i.id = s.integration_id where i.provider = 'discord') then
    raise exception 'the Discord server was not saved as a row without tokens';
  end if;
end $$;

-- 6. As the routes run them: the service role, whose own table grants these -----------------
-- security invoker functions need (call_integration_secrets is revoked from
-- everyone else). Rows to act on are made first, as the superuser.
insert into calls(id, community_id, workgroup_id, provider, title, starts_at, ends_at, amounts, created_by) values
  ('70000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001',
   'manual', 'Service call', '2026-10-03 18:00Z', '2026-10-03 19:00Z', '{"ADA":"5"}', 'alice'),
  ('70000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000001',
   'manual', 'Service delete', '2026-10-04 18:00Z', '2026-10-04 19:00Z', '{"ADA":"5"}', 'alice');
insert into call_attendees(id, call_id, provider, display_name, wallet_address, status) values
  ('71000000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000003', 'manual', 'Carol', 'carol', 'confirmed');
insert into tasks(id, workgroup_id, source, title, pay_state, audited) values
  ('30000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000001', 'native', 'Service edit', 'payable', true);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_call_amounts('70000000-0000-0000-0000-000000000003', '{"ADA":"6"}');
select finalize_call_at_reward('70000000-0000-0000-0000-000000000003', 'alice',
  array['71000000-0000-0000-0000-000000000003']::uuid[], 20, 6000000, '{"ADA":"6"}');
select delete_call_without_tasks('70000000-0000-0000-0000-000000000004');
select replace_task_assignees('30000000-0000-0000-0000-000000000009', '[{"source": "manual", "wallet": "carol"}]');
select save_call_integration('10000000-0000-0000-0000-000000000009', 'google', 'google-sub-1', 'Google account', 'alice',
  'access-g', 'refresh-g', '2026-10-01 15:00Z');
insert into auth_nonces(address, nonce, expires_at) values ('addr_service', 'service challenge', now() + interval '5 minutes');
delete from auth_nonces where address = 'addr_service';
reset role;

do $$ begin
  if (select count(*) from call_tasks where call_id = '70000000-0000-0000-0000-000000000003') <> 1
      or (select amounts from calls where id = '70000000-0000-0000-0000-000000000003') <> '{"ADA":"6"}'
      or exists (select 1 from calls where id = '70000000-0000-0000-0000-000000000004')
      or (select wallet_address from task_assignees where task_id = '30000000-0000-0000-0000-000000000009') <> 'carol'
      or (select s.refresh_token from call_integrations i join call_integration_secrets s on s.integration_id = i.id
          where i.community_id = '10000000-0000-0000-0000-000000000009' and i.provider = 'google') <> 'refresh-g'
      or exists (select 1 from auth_nonces where address = 'addr_service') then
    raise exception 'a 0063 function did not do its work as the service role';
  end if;
end $$;

rollback;
\echo Route hardening tests passed (all changes rolled back).
