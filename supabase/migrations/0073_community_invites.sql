-- Community invite links: an admin shares a URL; anyone who signs in with a
-- wallet and opens it joins as a plain member. The raw token is shown once
-- at creation; only its sha256 is stored. Platform accounts (Discord, GitHub,
-- Google) and display handles stay self-claimed on the Profile page.
--
-- All writes are service-role; members never read invite rows (the token is
-- the secret). redeem_community_invite locks the row so concurrent joins
-- cannot both burn the last use, and a wallet already in the community does
-- not increment the counter.

create table public.community_invites (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  token_hash text not null unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  -- null = no expiry / unlimited uses.
  expires_at timestamptz,
  max_uses int check (max_uses is null or max_uses > 0),
  use_count int not null default 0 check (use_count >= 0),
  last_used_at timestamptz,
  revoked_at timestamptz,
  -- Optional admin note (e.g. "Discord onboarding"); never shown to joiners.
  label text check (label is null or length(trim(label)) > 0)
);
create index community_invites_community_idx
  on public.community_invites (community_id, created_at desc);

alter table public.community_invites enable row level security;

revoke all on public.community_invites from anon, authenticated, service_role;
grant select, insert, update, delete on public.community_invites to service_role;

-- Atomically join the wallet (or report it is already a member). Raises
-- no_data_found when the invite is missing, revoked, expired or exhausted,
-- so callers can answer the same 404 for every invalid token.
create function public.redeem_community_invite(p_token_hash text, p_wallet text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.community_invites%rowtype;
  already boolean;
  community_slug text;
  community_name text;
  community_network int;
begin
  if p_token_hash is null or length(p_token_hash) = 0 then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;
  if p_wallet is null or length(p_wallet) = 0 then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;

  select * into inv
  from public.community_invites
  where token_hash = p_token_hash
  for update;

  -- Missing, revoked or expired: same answer for every guess. An existing
  -- member may still redeem a used-up invite (no second use is burned) so
  -- reopening their own link after joining stays friendly.
  if not found
     or inv.revoked_at is not null
     or (inv.expires_at is not null and inv.expires_at <= now()) then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;

  select exists(
    select 1 from public.community_members
    where community_id = inv.community_id and wallet_address = p_wallet
  ) into already;

  if not already then
    if inv.max_uses is not null and inv.use_count >= inv.max_uses then
      raise exception 'Invite not found' using errcode = 'P0002';
    end if;

    insert into public.contributors (wallet_address)
    values (p_wallet)
    on conflict (wallet_address) do nothing;

    insert into public.community_members (community_id, wallet_address, role)
    values (inv.community_id, p_wallet, 'member')
    on conflict (community_id, wallet_address) do nothing;

    update public.community_invites
    set use_count = use_count + 1,
        last_used_at = now()
    where id = inv.id;
  end if;

  select slug, name, network
  into community_slug, community_name, community_network
  from public.communities
  where id = inv.community_id;

  return jsonb_build_object(
    'communityId', inv.community_id,
    'slug', community_slug,
    'name', community_name,
    'network', community_network,
    'already', already
  );
end;
$$;

revoke all on function public.redeem_community_invite(text, text)
  from public, anon, authenticated;
grant execute on function public.redeem_community_invite(text, text) to service_role;

-- Drop invites that expired or were revoked long ago (kept a while so admins
-- can still see recent history). Active invites are never purged here.
create function public.purge_community_invites(p_now timestamptz)
returns integer
language plpgsql
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.community_invites
  where (expires_at is not null and expires_at < p_now - interval '90 days')
     or (revoked_at is not null and revoked_at < p_now - interval '90 days');
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.purge_community_invites(timestamptz)
  from public, anon, authenticated;
grant execute on function public.purge_community_invites(timestamptz) to service_role;
