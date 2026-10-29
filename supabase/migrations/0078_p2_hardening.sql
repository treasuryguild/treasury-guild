-- P2 hardening: contributors readable only with a wallet JWT claim; display
-- handles case-insensitive and charset-limited; table grants revoked on
-- service-only tables that still carried the default insert/update/delete.

-- 1. contributors_read: signed-in wallets only --------------------------------

-- 0046 revoked SELECT from anon; an authenticated JWT without a wallet claim
-- (or a forged role) must not list every handle either.
drop policy contributors_read on public.contributors;
create policy contributors_read on public.contributors for select
  using (public.jwt_wallet() is not null);

-- 2. Display handles ----------------------------------------------------------

-- Exact unique allowed "Ada" and "ada" as two people; matching is case-blind
-- in the UI, so uniqueness must be too. Charset keeps spaces / punctuation out
-- of assignee dropdowns and Discord-style paste matching.
alter table public.contributors drop constraint if exists contributors_handle_key;
create unique index if not exists contributors_handle_lower_uq
  on public.contributors (lower(handle))
  where handle is not null;
alter table public.contributors
  drop constraint if exists contributors_handle_charset;
alter table public.contributors
  add constraint contributors_handle_charset
  check (handle is null or handle ~ '^[A-Za-z0-9_-]{2,32}$');

-- 3. Service-only table grants (defense in depth) -----------------------------

-- RLS with no write policy already refuses; without these revokes PostgREST
-- still advertises the verbs. Tables that already revoke all are listed again
-- so a restored default privilege cannot reopen them.
revoke insert, update, delete on public.auth_nonces from anon, authenticated;
revoke insert, update, delete on public.webhook_events from anon, authenticated;
revoke insert, update, delete on public.call_checkin_codes from anon, authenticated;
revoke insert, update, delete on public.call_name_aliases from anon, authenticated;
revoke insert, update, delete on public.call_integration_secrets from anon, authenticated;
revoke insert, update, delete on public.call_pending_sessions from anon, authenticated;
revoke insert, update, delete on public.zoom_webhook_deliveries from anon, authenticated;
revoke insert, update, delete on public.treasury_cosigner_keys from anon, authenticated;
revoke insert, update, delete on public.rate_limits from anon, authenticated;
revoke insert, update, delete on public.oauth_clients from anon, authenticated;
revoke insert, update, delete on public.oauth_grants from anon, authenticated;
revoke insert, update, delete on public.oauth_authorization_codes from anon, authenticated;
revoke insert, update, delete on public.oauth_refresh_tokens from anon, authenticated;
revoke insert, update, delete on public.community_invites from anon, authenticated;
revoke insert, update, delete on public.legacy_wallets from anon, authenticated;
revoke insert, update, delete on public.legacy_imports from anon, authenticated;
revoke insert, update, delete on public.legacy_payments from anon, authenticated;
revoke insert, update, delete on public.legacy_payment_amounts from anon, authenticated;
revoke insert, update, delete on public.workgroup_import_aliases from anon, authenticated;
revoke insert, update, delete on public.proposal_anchor_alerts from anon, authenticated;
revoke insert, update, delete on public.governance_discord_channels from anon, authenticated;
revoke insert, update, delete on public.treasury_discord_destinations from anon, authenticated;
