-- Migration 0098: import drafts are service-role only. Claim matches key_hash;
-- recovery/cosigner require membership; creator must be a base key.
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
\ir ../migrations/0078_reconcile_refund_cap.sql
\ir ../migrations/0079_future_budget_month.sql
\ir ../migrations/0080_confirm_pending_on_chain.sql
\ir ../migrations/0081_assignee_github_user_id.sql
\ir ../migrations/0082_p2_hardening.sql
\ir ../migrations/0083_lead_changes.sql
\ir ../migrations/0084_signed_delete_and_task_claim.sql
\ir ../migrations/0085_canceled_tx_ttl.sql
\ir ../migrations/0086_external_tx_activity.sql
\ir ../migrations/0087_external_tx_cbor.sql
\ir ../migrations/0088_float_wallets.sql
\ir ../migrations/0089_incoming_conversions.sql
\ir ../migrations/0090_float_sync_from.sql
\ir ../migrations/0091_payday_allocation_rules.sql
\ir ../migrations/0092_recognition.sql
\ir ../migrations/0093_agent_csv_imports.sql
\ir ../migrations/0094_legacy_history_row_cap.sql
\ir ../migrations/0095_legacy_receipts.sql
\ir ../migrations/0096_verified_legacy_import.sql
\ir ../migrations/0097_legacy_import_stage_guards.sql
\ir ../migrations/0098_treasury_import_drafts.sql

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
select pg_temp.reject($$select * from treasury_import_drafts$$, '42501');
select pg_temp.reject($$select * from treasury_import_draft_signers$$, '42501');
select pg_temp.reject($$select claim_treasury_import_invite('x', 'w', repeat('a', 56), null)$$, '42501');
select pg_temp.reject($$select purge_treasury_import_drafts(now())$$, '42501');
reset role;
set local role anon;
select pg_temp.reject($$select * from treasury_import_drafts$$, '42501');
select pg_temp.reject($$select claim_treasury_import_invite('x', 'w', repeat('a', 56), null)$$, '42501');
reset role;

set local role service_role;

insert into contributors(wallet_address) values ('addr_alice'), ('addr_bob'), ('addr_carol'), ('addr_dave');
insert into communities(id, slug, name, network, created_by)
values ('10000000-0000-4000-8000-000000000001', 'demo', 'Demo', 0, 'addr_alice');
insert into community_members(community_id, wallet_address, role)
values
  ('10000000-0000-4000-8000-000000000001', 'addr_alice', 'admin'),
  ('10000000-0000-4000-8000-000000000001', 'addr_carol', 'member');

-- Alice (base) creates; her base slot is claimed. Bob (base) and Carol (recovery) wait.
do $$ declare new_id uuid; begin
  new_id := create_treasury_import_draft(
    '10000000-0000-4000-8000-000000000001',
    'hash-one',
    'addr_alice',
    repeat('aa', 28),
    'Imported',
    null,
    now() + interval '7 days',
    '8201828200581c' || repeat('aa', 28) || '8200581c' || repeat('bb', 28),
    null,
    jsonb_build_array(
      jsonb_build_object('keyHash', repeat('aa', 28), 'group', 'base', 'name', 'Alice'),
      jsonb_build_object('keyHash', repeat('bb', 28), 'group', 'base', 'name', 'Bob'),
      jsonb_build_object('keyHash', repeat('cc', 28), 'group', 'recovery', 'name', 'Carol')
    )
  );
  if (select count(*) from treasury_import_draft_signers where draft_id = new_id) <> 3 then
    raise exception 'Expected three signer slots';
  end if;
  if (select wallet_address from treasury_import_draft_signers
      where draft_id = new_id and key_hash = repeat('aa', 28)) <> 'addr_alice' then
    raise exception 'Alice base slot was not auto-claimed';
  end if;
  if (select wallet_address from treasury_import_draft_signers
      where draft_id = new_id and key_hash = repeat('bb', 28)) is not null then
    raise exception 'Bob must start unclaimed';
  end if;
end $$;

-- Creator who is not a base key is refused.
select pg_temp.reject($$
  select create_treasury_import_draft(
    '10000000-0000-4000-8000-000000000001',
    'hash-bad',
    'addr_bob',
    repeat('ff', 28),
    'Nope',
    null,
    now() + interval '7 days',
    '8200',
    null,
    jsonb_build_array(
      jsonb_build_object('keyHash', repeat('aa', 28), 'group', 'base'),
      jsonb_build_object('keyHash', repeat('bb', 28), 'group', 'base')
    )
  )
$$, '22023');

-- Bob claims his base slot via the invite token.
select claim_treasury_import_invite('hash-one', 'addr_bob', repeat('bb', 28), 'Bob');
do $$ declare bob text; begin
  select wallet_address into bob from treasury_import_draft_signers
  where key_hash = repeat('bb', 28);
  if bob <> 'addr_bob' then raise exception 'Bob was not claimed'; end if;
end $$;

-- Wrong key, already-claimed key, unknown token.
select pg_temp.reject(
  $$select claim_treasury_import_invite('hash-one', 'addr_dave', repeat('ff', 28), null)$$,
  '22023'
);
select pg_temp.reject(
  $$select claim_treasury_import_invite('hash-one', 'addr_dave', repeat('aa', 28), null)$$,
  '22023'
);
select pg_temp.reject(
  $$select claim_treasury_import_invite('missing', 'addr_bob', repeat('bb', 28), null)$$,
  'P0002'
);

-- Recovery non-member refused; Carol (member) can claim recovery; Dave cannot.
select pg_temp.reject(
  $$select claim_treasury_import_invite('hash-one', 'addr_dave', repeat('cc', 28), null)$$,
  '22023'
);
select claim_treasury_import_invite('hash-one', 'addr_carol', repeat('cc', 28), 'Carol');

-- Admin paste overwrite on a fresh draft slot.
do $$ declare new_id uuid; begin
  new_id := create_treasury_import_draft(
    '10000000-0000-4000-8000-000000000001',
    'hash-two',
    'addr_alice',
    repeat('11', 28),
    'Paste',
    null,
    now() + interval '7 days',
    '8201',
    null,
    jsonb_build_array(
      jsonb_build_object('keyHash', repeat('11', 28), 'group', 'base'),
      jsonb_build_object('keyHash', repeat('22', 28), 'group', 'base')
    )
  );
  perform set_treasury_import_draft_slot_address(
    new_id, repeat('22', 28), 'addr_bob', 'Bob'
  );
  if (select wallet_address from treasury_import_draft_signers
      where draft_id = new_id and key_hash = repeat('22', 28)) <> 'addr_bob' then
    raise exception 'Paste did not claim Bob';
  end if;
end $$;

-- Cap of 10 open import drafts.
do $$ declare i int; begin
  for i in 3..10 loop
    perform create_treasury_import_draft(
      '10000000-0000-4000-8000-000000000001',
      'hash-cap-' || i,
      'addr_alice',
      repeat('aa', 28),
      'Cap ' || i,
      null,
      now() + interval '7 days',
      '8200' || i,
      null,
      jsonb_build_array(
        jsonb_build_object('keyHash', repeat('aa', 28), 'group', 'base'),
        jsonb_build_object('keyHash', repeat('bb', 28), 'group', 'base')
      )
    );
  end loop;
end $$;
select pg_temp.reject($$
  select create_treasury_import_draft(
    '10000000-0000-4000-8000-000000000001',
    'hash-cap-11',
    'addr_alice',
    repeat('aa', 28),
    'Too many',
    null,
    now() + interval '7 days',
    '820099',
    null,
    jsonb_build_array(
      jsonb_build_object('keyHash', repeat('aa', 28), 'group', 'base'),
      jsonb_build_object('keyHash', repeat('bb', 28), 'group', 'base')
    )
  )
$$, '22023');

-- Purge expired drafts.
update treasury_import_drafts set expires_at = now() - interval '1 minute' where token_hash = 'hash-one';
do $$ declare removed int; begin
  removed := purge_treasury_import_drafts(now());
  if removed < 1 then raise exception 'Expected purge to remove expired draft'; end if;
  if exists (select 1 from treasury_import_drafts where token_hash = 'hash-one') then
    raise exception 'Expired draft still present';
  end if;
end $$;

rollback;
