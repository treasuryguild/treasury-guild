-- Migrations 0053-0054: the agent API's OAuth tables are service-role only, one-time
-- codes and refresh-token claims are conditional updates, and purge_oauth keeps
-- what replay detection and live grants need. Run with psql -f against an EMPTY
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

-- Sessions and the anon key can neither read nor write any of it, nor purge.
set local role authenticated;
select pg_temp.reject($$select * from oauth_clients$$, '42501');
select pg_temp.reject($$select * from oauth_grants$$, '42501');
select pg_temp.reject($$select * from oauth_authorization_codes$$, '42501');
select pg_temp.reject($$select * from oauth_refresh_tokens$$, '42501');
select pg_temp.reject($$insert into oauth_grants(wallet_address, client_id, scopes) values ('w', 'c', '{x}')$$, '42501');
select pg_temp.reject($$select purge_oauth(now())$$, '42501');
reset role;
set local role anon;
select pg_temp.reject($$select * from oauth_clients$$, '42501');
select pg_temp.reject($$select * from oauth_refresh_tokens$$, '42501');
select pg_temp.reject($$select purge_oauth(now())$$, '42501');
reset role;

set local role service_role;

-- A public client has no secret; a confidential one must have one.
insert into oauth_clients(client_id, client_name, redirect_uris)
  values ('dcr-live', 'Claude', '{http://127.0.0.1/callback}');
select pg_temp.reject($$insert into oauth_clients(client_id, client_name, redirect_uris, secret_hash)
  values ('bad', 'x', '{https://x.test/cb}', 'h')$$, '23514');
select pg_temp.reject($$insert into oauth_clients(client_id, client_name, redirect_uris, token_endpoint_auth_method)
  values ('bad', 'x', '{https://x.test/cb}', 'client_secret_post')$$, '23514');
-- An empty scope set is not a grant.
select pg_temp.reject($$insert into oauth_grants(wallet_address, client_id, scopes) values ('addr_w', 'dcr-live', '{}')$$, '23514');

insert into oauth_grants(wallet_address, client_id, scopes) values ('addr_w', 'dcr-live', '{communities:read}');

-- A code is consumed exactly once: the second conditional update claims nothing.
insert into oauth_authorization_codes(code_hash, client_id, wallet_address, scopes, resource, redirect_uri, code_challenge, expires_at)
  values ('code1', 'dcr-live', 'addr_w', '{communities:read}', 'http://localhost:3000/api/mcp', 'http://127.0.0.1/callback', 'c', now() + interval '1 minute');
do $$ declare n integer; begin
  update oauth_authorization_codes set consumed_at = now() where code_hash = 'code1' and consumed_at is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'first redemption must claim the code'; end if;
  update oauth_authorization_codes set consumed_at = now() where code_hash = 'code1' and consumed_at is null;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a code must not be claimed twice'; end if;
end $$;

-- Refresh rotation: the old token is claimed once and linked to its successor.
insert into oauth_refresh_tokens(id, token_hash, client_id, wallet_address, scopes, resource, expires_at)
  values ('00000000-0000-4000-8000-000000000001', 'rt1', 'dcr-live', 'addr_w', '{communities:read}', 'r', now() + interval '30 days'),
         ('00000000-0000-4000-8000-000000000002', 'rt2', 'dcr-live', 'addr_w', '{communities:read}', 'r', now() + interval '30 days');
do $$ declare n integer; begin
  update oauth_refresh_tokens set revoked_at = now()
    where token_hash = 'rt1' and revoked_at is null and replaced_by is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'first refresh must claim the token'; end if;
  update oauth_refresh_tokens set replaced_by = '00000000-0000-4000-8000-000000000002' where token_hash = 'rt1';
  update oauth_refresh_tokens set revoked_at = now()
    where token_hash = 'rt1' and revoked_at is null and replaced_by is null;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a rotated token must not be claimed again'; end if;
end $$;
-- A token hash identifies one token.
select pg_temp.reject($$insert into oauth_refresh_tokens(token_hash, client_id, wallet_address, scopes, resource, expires_at)
  values ('rt1', 'dcr-live', 'addr_w', '{communities:read}', 'r', now())$$, '23505');

-- Purge: expired codes and refresh tokens go, and so do an old DCR client and a
-- metadata-document client not fetched for a day that nobody approved (0054);
-- a client with a grant and a recently fetched metadata-document client stay.
insert into oauth_clients(client_id, client_name, redirect_uris, created_at)
  values ('dcr-orphan', 'Stray', '{https://x.test/cb}', now() - interval '2 days'),
         ('https://client.test/meta.json', 'CIMD', '{https://client.test/cb}', now() - interval '2 days'),
         ('https://stale.test/meta.json', 'Stale CIMD', '{https://stale.test/cb}', now() - interval '2 days');
update oauth_clients set is_metadata_url = true where client_id like 'https://%';
update oauth_clients set last_seen_at = now() - interval '2 days' where client_id = 'https://stale.test/meta.json';
update oauth_clients set created_at = now() - interval '2 days' where client_id = 'dcr-live';
insert into oauth_authorization_codes(code_hash, client_id, wallet_address, scopes, resource, redirect_uri, code_challenge, expires_at)
  values ('code-old', 'dcr-live', 'addr_w', '{communities:read}', 'r', 'u', 'c', now() - interval '2 days');
insert into oauth_refresh_tokens(token_hash, client_id, wallet_address, scopes, resource, expires_at)
  values ('rt-old', 'dcr-live', 'addr_w', '{communities:read}', 'r', now() - interval '1 second');
do $$ declare removed integer; begin
  removed := purge_oauth(now());
  if removed <> 4 then raise exception 'expected 4 rows purged, got %', removed; end if;
  if exists (select 1 from oauth_clients where client_id = 'dcr-orphan') then raise exception 'orphan DCR client kept'; end if;
  if exists (select 1 from oauth_clients where client_id = 'https://stale.test/meta.json') then raise exception 'stale CIMD client kept'; end if;
  if not exists (select 1 from oauth_clients where client_id = 'dcr-live') then raise exception 'granted client purged'; end if;
  if not exists (select 1 from oauth_clients where client_id = 'https://client.test/meta.json') then raise exception 'fresh CIMD client purged'; end if;
  if not exists (select 1 from oauth_authorization_codes where code_hash = 'code1') then raise exception 'fresh code purged'; end if;
  if (select count(*) from oauth_refresh_tokens) <> 2 then raise exception 'live refresh tokens purged'; end if;
end $$;

-- Deleting a client removes its grants, codes and tokens with it.
delete from oauth_clients where client_id = 'dcr-live';
do $$ begin
  if exists (select 1 from oauth_grants) or exists (select 1 from oauth_refresh_tokens)
     or exists (select 1 from oauth_authorization_codes) then
    raise exception 'client delete must cascade';
  end if;
end $$;
reset role;

rollback;
