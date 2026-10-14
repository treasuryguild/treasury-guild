-- Verified external accounts of a wallet, beyond GitHub: the Discord user and
-- the Google account, so call capture (voice snapshots, Meet reports) can
-- recognise a contributor. Written only by the service-role OAuth callbacks
-- after the provider confirmed the account, like contributors.github_username.
--
-- Unlike a GitHub login, which labels public work, these ids say nothing a
-- community needs to see: only the wallet itself reads its rows. Server code
-- resolves attendees through the service role.
--
-- One account per provider per wallet, and one wallet per account: a second
-- wallet claiming the same account is refused (the callback reports "taken").

create table public.contributor_identities (
  wallet_address text not null references public.contributors(wallet_address) on delete cascade,
  provider text not null check (provider in ('discord', 'google')),
  -- Discord user id (snowflake) / Google OpenID `sub`.
  external_id text not null check (length(external_id) > 0),
  -- What the provider calls the account, for the owner's profile page. Google
  -- is asked for `openid` only, so it has none.
  display_name text,
  verified_at timestamptz not null default now(),
  primary key (wallet_address, provider),
  unique (provider, external_id)
);

alter table public.contributor_identities enable row level security;
create policy contributor_identities_read_own on public.contributor_identities
  for select using (wallet_address = public.jwt_wallet());
revoke all on public.contributor_identities from anon, authenticated, service_role;
grant select on public.contributor_identities to authenticated;
grant select, insert, update, delete on public.contributor_identities to service_role;
