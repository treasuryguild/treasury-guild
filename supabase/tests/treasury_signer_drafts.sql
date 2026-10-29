-- Migration 0077: SDK signer drafts are service-role only. A wallet can write
-- only its own stake address; expired and unknown tokens are no_data_found.
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
\ir ../migrations/0075_sdk_staking_drep.sql
\ir ../migrations/0076_registration_tx_kind.sql
\ir ../migrations/0077_treasury_signer_drafts.sql

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
select pg_temp.reject($$select * from treasury_signer_drafts$$, '42501');
select pg_temp.reject($$select * from treasury_signer_draft_signers$$, '42501');
select pg_temp.reject($$select contribute_treasury_signer_keys('x', 'w', 'stake_test1q', null)$$, '42501');
select pg_temp.reject($$select purge_treasury_signer_drafts(now())$$, '42501');
reset role;
set local role anon;
select pg_temp.reject($$select * from treasury_signer_drafts$$, '42501');
select pg_temp.reject($$select contribute_treasury_signer_keys('x', 'w', 'stake_test1q', null)$$, '42501');
reset role;

set local role service_role;

insert into contributors(wallet_address) values ('addr_alice'), ('addr_bob');
insert into communities(id, slug, name, network, created_by)
values ('10000000-0000-4000-8000-000000000001', 'demo', 'Demo', 0, 'addr_alice');

-- Creator's own stake is kept; the other signer's keys in the same body are dropped.
do $$ declare new_id uuid; begin
  new_id := create_treasury_signer_draft(
    '10000000-0000-4000-8000-000000000001',
    'hash-one',
    'addr_alice',
    'Main',
    2,
    null,
    now() + interval '7 days',
    jsonb_build_array(
      jsonb_build_object(
        'address', 'addr_alice',
        'name', 'Alice',
        'stakeAddress', 'stake_test1qpzry9x8gf2tvdw0s3jn54khce6mua7l',
        'drepKeyHash', repeat('ab', 28)
      ),
      jsonb_build_object(
        'address', 'addr_bob',
        'name', 'Bob',
        'stakeAddress', 'stake_test1yyyyyyyyyyyyyyyyyyyyyyyy',
        'drepKeyHash', repeat('cd', 28)
      )
    )
  );
  if new_id is null then
    raise exception 'create returned null';
  end if;
  if (select stake_address from treasury_signer_draft_signers
      where draft_id = new_id and wallet_address = 'addr_alice')
     <> 'stake_test1qpzry9x8gf2tvdw0s3jn54khce6mua7l' then
    raise exception 'Alice stake was not stored';
  end if;
  if (select drep_key_hash from treasury_signer_draft_signers
      where draft_id = new_id and wallet_address = 'addr_alice') <> repeat('ab', 28) then
    raise exception 'Alice DRep hash was not stored';
  end if;
  if (select stake_address from treasury_signer_draft_signers
      where draft_id = new_id and wallet_address = 'addr_bob') is not null then
    raise exception 'Bob stake from the creator body must be ignored';
  end if;
end $$;

-- Bob connects: only his row changes. Repeating overwrites his stake.
select contribute_treasury_signer_keys(
  'hash-one', 'addr_bob', 'stake_test1yyyyyyyyyyyyyyyyyyyyyyyy', repeat('CD', 28)
);
do $$ declare alice text; bob text; bob_drep text; begin
  select stake_address into alice from treasury_signer_draft_signers
  where wallet_address = 'addr_alice';
  select stake_address, drep_key_hash into bob, bob_drep from treasury_signer_draft_signers
  where wallet_address = 'addr_bob';
  if alice <> 'stake_test1qpzry9x8gf2tvdw0s3jn54khce6mua7l' then
    raise exception 'Alice stake changed when Bob contributed';
  end if;
  if bob <> 'stake_test1yyyyyyyyyyyyyyyyyyyyyyyy' or bob_drep <> repeat('cd', 28) then
    raise exception 'Bob keys were not stored (drep should be lowercased): % %', bob, bob_drep;
  end if;
end $$;

select contribute_treasury_signer_keys(
  'hash-one', 'addr_bob', 'stake_test1qpzry9x8gf2tvdw0s3jn54khce6mua7lzzzz', null
);
do $$ declare bob text; bob_drep text; begin
  select stake_address, drep_key_hash into bob, bob_drep from treasury_signer_draft_signers
  where wallet_address = 'addr_bob';
  if bob <> 'stake_test1qpzry9x8gf2tvdw0s3jn54khce6mua7lzzzz' or bob_drep is not null then
    raise exception 'Overwrite did not replace Bob keys: % %', bob, bob_drep;
  end if;
end $$;

-- A wallet that is not listed, a mainnet stake address, and an unknown token.
select pg_temp.reject(
  $$select contribute_treasury_signer_keys('hash-one', 'addr_carol', 'stake_test1qpzry9x8gf2tvdw0s3jn54khce6mua7l', null)$$,
  '22023'
);
select pg_temp.reject(
  $$select contribute_treasury_signer_keys('hash-one', 'addr_alice', 'stake1qpzry9x8gf2tvdw0s3jn54khce6mua7l', null)$$,
  '22023'
);
select pg_temp.reject(
  $$select contribute_treasury_signer_keys('missing', 'addr_alice', 'stake_test1qpzry9x8gf2tvdw0s3jn54khce6mua7l', null)$$,
  'P0002'
);

-- Expired token is the same not-found, and does not write.
insert into treasury_signer_drafts(id, community_id, token_hash, created_by, name, required, expires_at)
values (
  '30000000-0000-4000-8000-000000000099',
  '10000000-0000-4000-8000-000000000001',
  'hash-expired',
  'addr_alice',
  'Old',
  1,
  now() - interval '1 hour'
);
insert into treasury_signer_draft_signers(draft_id, position, wallet_address)
values ('30000000-0000-4000-8000-000000000099', 0, 'addr_alice');
select pg_temp.reject(
  $$select contribute_treasury_signer_keys('hash-expired', 'addr_alice', 'stake_test1qpzry9x8gf2tvdw0s3jn54khce6mua7l', null)$$,
  'P0002'
);
do $$ begin
  if (select stake_address from treasury_signer_draft_signers
      where draft_id = '30000000-0000-4000-8000-000000000099') is not null then
    raise exception 'Expired invite accepted a stake address';
  end if;
end $$;

-- Replacing the list drops keys for an address that left and keeps the rest.
select save_treasury_signer_draft(
  (select id from treasury_signer_drafts where token_hash = 'hash-one'),
  'Main',
  1,
  null,
  jsonb_build_array(jsonb_build_object('address', 'addr_alice', 'name', 'Alice')),
  'addr_alice',
  null,
  null
);
do $$ declare n int; alice text; begin
  select count(*) into n from treasury_signer_draft_signers s
  join treasury_signer_drafts d on d.id = s.draft_id
  where d.token_hash = 'hash-one';
  select s.stake_address into alice from treasury_signer_draft_signers s
  join treasury_signer_drafts d on d.id = s.draft_id
  where d.token_hash = 'hash-one' and s.wallet_address = 'addr_alice';
  if n <> 1 or alice <> 'stake_test1qpzry9x8gf2tvdw0s3jn54khce6mua7l' then
    raise exception 'Save did not keep Alice and drop Bob: n=% alice=%', n, alice;
  end if;
  if exists (
    select 1 from treasury_signer_draft_signers s
    join treasury_signer_drafts d on d.id = s.draft_id
    where d.token_hash = 'hash-one' and s.wallet_address = 'addr_bob'
  ) then
    raise exception 'Bob was not removed';
  end if;
end $$;

-- Purge removes expired drafts and the signer rows that cascade, and leaves the open one.
do $$ declare removed integer; begin
  removed := purge_treasury_signer_drafts(now());
  if removed <> 1 then
    raise exception 'Expected to purge 1 expired draft, got %', removed;
  end if;
  if exists (select 1 from treasury_signer_drafts where token_hash = 'hash-expired') then
    raise exception 'Expired draft survived purge';
  end if;
  if exists (
    select 1 from treasury_signer_draft_signers
    where draft_id = '30000000-0000-4000-8000-000000000099'
  ) then
    raise exception 'Expired signer row survived purge';
  end if;
  if not exists (select 1 from treasury_signer_drafts where token_hash = 'hash-one') then
    raise exception 'Open draft was purged';
  end if;
end $$;

rollback;
