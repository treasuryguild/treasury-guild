-- Agent API authorization server (OAuth 2.1 for /api/mcp and /api/v1).
--
-- An AI client (claude.ai, Claude Desktop, Claude Code) registers, sends the
-- user to a consent page where they sign in with their wallet and approve,
-- and receives short-lived access tokens plus a rotating refresh token.
--
-- Nothing secret is stored in plaintext: authorization codes, refresh tokens
-- and client secrets are sha256 hashes. Every table is service-role only (RLS
-- on, no policies, no grants to anon / authenticated): the OAuth routes and
-- the Settings page's connection list read and write them in code.

-- A registered client: an opaque id from Dynamic Client Registration, or the
-- https URL of its Client ID Metadata Document (cached, re-fetched hourly).
create table public.oauth_clients (
  client_id text primary key,
  is_metadata_url boolean not null default false,
  client_name text not null,
  client_uri text,
  redirect_uris text[] not null,
  token_endpoint_auth_method text not null default 'none'
    check (token_endpoint_auth_method in ('none', 'client_secret_post')),
  secret_hash text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  check ((token_endpoint_auth_method = 'none') = (secret_hash is null))
);

-- "This wallet approved this client": one row per pair, so consenting again
-- updates it and the user has one thing to revoke. It is re-read on every
-- agent API request, so a revocation or a narrowed scope applies at once.
create table public.oauth_grants (
  wallet_address text not null,
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  scopes text[] not null check (cardinality(scopes) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (wallet_address, client_id)
);
create index oauth_grants_client_idx on public.oauth_grants(client_id);

-- One-time codes, redeemed within a minute with the PKCE verifier. A code
-- presented twice means it leaked: the token route then revokes every
-- refresh token of that (client, wallet).
create table public.oauth_authorization_codes (
  code_hash text primary key,
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  wallet_address text not null,
  scopes text[] not null check (cardinality(scopes) > 0),
  resource text not null,
  redirect_uri text not null,
  code_challenge text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index oauth_authorization_codes_expires_idx on public.oauth_authorization_codes(expires_at);

-- Rotating refresh tokens. A redeemed token is revoked and linked to its
-- successor; presenting one that already has a successor is a replay and
-- revokes the whole chain of that (client, wallet).
create table public.oauth_refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  wallet_address text not null,
  scopes text[] not null check (cardinality(scopes) > 0),
  resource text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by uuid references public.oauth_refresh_tokens(id) on delete set null,
  created_at timestamptz not null default now()
);
create index oauth_refresh_tokens_owner_idx on public.oauth_refresh_tokens(client_id, wallet_address);
create index oauth_refresh_tokens_expires_idx on public.oauth_refresh_tokens(expires_at);

alter table public.oauth_clients enable row level security;
alter table public.oauth_grants enable row level security;
alter table public.oauth_authorization_codes enable row level security;
alter table public.oauth_refresh_tokens enable row level security;

revoke all on public.oauth_clients, public.oauth_grants,
  public.oauth_authorization_codes, public.oauth_refresh_tokens
  from anon, authenticated, service_role;
grant select, insert, update, delete on public.oauth_clients, public.oauth_grants,
  public.oauth_authorization_codes, public.oauth_refresh_tokens
  to service_role;

-- Retention (reconcile sweep): codes a day after they expired, refresh tokens
-- once expired (a revoked token is kept until then so a replay is still
-- recognised), and Dynamic Client Registration clients that never got a grant
-- within a day (every fresh connection registers one). Returns rows removed.
create function public.purge_oauth(p_now timestamptz)
returns integer
language plpgsql set search_path = public as $$
declare
  removed integer := 0;
  n integer;
begin
  delete from oauth_authorization_codes where expires_at < p_now - interval '1 day';
  get diagnostics n = row_count; removed := removed + n;

  delete from oauth_refresh_tokens where expires_at < p_now;
  get diagnostics n = row_count; removed := removed + n;

  delete from oauth_clients c
  where not c.is_metadata_url
    and c.created_at < p_now - interval '1 day'
    and not exists (select 1 from oauth_grants g where g.client_id = c.client_id)
    and not exists (select 1 from oauth_refresh_tokens r where r.client_id = c.client_id);
  get diagnostics n = row_count; removed := removed + n;

  return removed;
end $$;
revoke all on function public.purge_oauth(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_oauth(timestamptz) to service_role;
