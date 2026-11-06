-- CBOR / CIP-0146 treasury import invites: an admin pastes a native script,
-- each signer connects (or the admin pastes a matching payment address) to
-- claim a key-hash slot, and the treasury is created only once every slot is
-- claimed. The raw token is shown once; only its sha256 is stored. Script CBOR
-- and claimed addresses live here until the treasury is created or the draft
-- expires.
--
-- All writes are service-role. Members never read these rows. Payment key
-- hashes are computed in the app (Cardano); RPCs trust the service-role caller
-- to pass the correct hash for a wallet.

create table public.treasury_import_drafts (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  token_hash text not null unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  workgroup_id uuid references public.workgroups(id) on delete set null,
  script_cbor text not null check (script_cbor ~ '^[0-9a-f]+$' and char_length(script_cbor) between 2 and 32768),
  stake_credential_hash text check (
    stake_credential_hash is null or stake_credential_hash ~ '^[0-9a-f]{56}$'
  )
);
create index treasury_import_drafts_community_idx
  on public.treasury_import_drafts (community_id, expires_at);

create table public.treasury_import_draft_signers (
  draft_id uuid not null references public.treasury_import_drafts(id) on delete cascade,
  position int not null check (position >= 0),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{56}$'),
  signer_group text not null check (signer_group in ('base', 'recovery', 'cosigner')),
  wallet_address text check (wallet_address is null or length(btrim(wallet_address)) > 0),
  display_name text,
  claimed_at timestamptz,
  primary key (draft_id, position),
  unique (draft_id, key_hash),
  unique (draft_id, wallet_address)
);

alter table public.treasury_import_drafts enable row level security;
alter table public.treasury_import_draft_signers enable row level security;

revoke all on public.treasury_import_drafts from anon, authenticated, service_role;
revoke all on public.treasury_import_draft_signers from anon, authenticated, service_role;
grant select, insert, update, delete on public.treasury_import_drafts to service_role;
grant select, insert, update, delete on public.treasury_import_draft_signers to service_role;

-- Claim one unclaimed slot whose key_hash matches. Recovery and co-signer
-- slots require an existing community membership. Re-claiming the same wallet
-- onto its already-claimed slot is a no-op success (idempotent reconnect).
create function public.claim_treasury_import_draft_slot(
  p_draft_id uuid,
  p_wallet text,
  p_key_hash text,
  p_display_name text
) returns void
language plpgsql
set search_path = public
as $fn$
declare
  draft public.treasury_import_drafts%rowtype;
  v_hash text;
  v_wallet text;
  v_name text;
  v_group text;
  v_existing text;
begin
  select * into draft
  from public.treasury_import_drafts
  where id = p_draft_id
  for update;

  if not found or draft.expires_at <= now() then
    raise exception 'Import invite not found' using errcode = 'P0002';
  end if;

  v_wallet := nullif(btrim(coalesce(p_wallet, '')), '');
  v_hash := nullif(lower(btrim(coalesce(p_key_hash, ''))), '');
  if v_wallet is null or v_hash is null or v_hash !~ '^[0-9a-f]{56}$' then
    raise exception 'Connect a wallet whose payment key is in this script' using errcode = '22023';
  end if;

  select signer_group, wallet_address
    into v_group, v_existing
  from public.treasury_import_draft_signers
  where draft_id = p_draft_id and key_hash = v_hash
  for update;

  if not found then
    raise exception 'This wallet is not a signer of the imported script' using errcode = '22023';
  end if;

  if v_existing is not null and v_existing <> v_wallet then
    raise exception 'That signer key is already claimed' using errcode = '22023';
  end if;

  if v_existing = v_wallet then
    return;
  end if;

  if exists (
    select 1 from public.treasury_import_draft_signers
    where draft_id = p_draft_id and wallet_address = v_wallet
  ) then
    raise exception 'This wallet already claimed another signer key' using errcode = '22023';
  end if;

  if v_group in ('recovery', 'cosigner') and not exists (
    select 1 from public.community_members
    where community_id = draft.community_id and wallet_address = v_wallet
  ) then
    raise exception 'Recovery signers and the co-signer must already be community members'
      using errcode = '22023';
  end if;

  v_name := nullif(btrim(coalesce(p_display_name, '')), '');

  update public.treasury_import_draft_signers
  set wallet_address = v_wallet,
      display_name = coalesce(v_name, display_name),
      claimed_at = now()
  where draft_id = p_draft_id and key_hash = v_hash;
end;
$fn$;

revoke all on function public.claim_treasury_import_draft_slot(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_treasury_import_draft_slot(uuid, text, text, text)
  to service_role;

-- Open a draft from decoded CBOR slots. The creator's payment key must match a
-- base slot (anti-squat); that slot is claimed immediately.
create function public.create_treasury_import_draft(
  p_community_id uuid,
  p_token_hash text,
  p_created_by text,
  p_creator_key_hash text,
  p_name text,
  p_workgroup_id uuid,
  p_expires_at timestamptz,
  p_script_cbor text,
  p_stake_credential_hash text,
  p_signers jsonb
) returns uuid
language plpgsql
set search_path = public
as $fn$
declare
  v_id uuid;
  v_name text;
  v_count int;
  v_cbor text;
  v_stake text;
  v_creator_hash text;
  v_elem jsonb;
  v_ord int;
  v_hash text;
  v_group text;
  v_base_match boolean := false;
begin
  v_name := btrim(p_name);
  if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 100 then
    raise exception 'Name the treasury' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'Import invite not found' using errcode = '22023';
  end if;

  v_cbor := nullif(lower(btrim(coalesce(p_script_cbor, ''))), '');
  if v_cbor is null or v_cbor !~ '^[0-9a-f]+$' or char_length(v_cbor) > 32768 then
    raise exception 'Paste a native script as CBOR hex (up to 16 KB)' using errcode = '22023';
  end if;

  v_stake := nullif(lower(btrim(coalesce(p_stake_credential_hash, ''))), '');
  if v_stake is not null and v_stake !~ '^[0-9a-f]{56}$' then
    raise exception 'Invalid stake credential hash' using errcode = '22023';
  end if;

  v_creator_hash := nullif(lower(btrim(coalesce(p_creator_key_hash, ''))), '');
  if v_creator_hash is null or v_creator_hash !~ '^[0-9a-f]{56}$' then
    raise exception 'You must be a base signer of the treasury you are importing'
      using errcode = '22023';
  end if;

  v_count := coalesce(jsonb_array_length(p_signers), 0);
  if v_count < 1 then
    raise exception 'Provide one matching wallet address for every signer in the imported script'
      using errcode = '22023';
  end if;
  if (
    select count(distinct lower(btrim(elem->>'keyHash')))
    from jsonb_array_elements(p_signers) elem
  ) <> v_count then
    raise exception 'A wallet cannot be in two groups of the same treasury' using errcode = '22023';
  end if;

  if p_workgroup_id is not null and not exists (
    select 1 from public.workgroups
    where id = p_workgroup_id and community_id = p_community_id
  ) then
    raise exception 'Choose a workgroup of this community' using errcode = '22023';
  end if;

  if not exists (select 1 from public.communities where id = p_community_id) then
    raise exception 'Import invite not found' using errcode = 'P0002';
  end if;

  if (
    select count(*) from public.treasury_import_drafts
    where community_id = p_community_id and expires_at > now()
  ) >= 10 then
    raise exception 'This community already has 10 open import invites. Discard one first.'
      using errcode = '22023';
  end if;

  insert into public.treasury_import_drafts (
    community_id, token_hash, created_by, expires_at, name, workgroup_id,
    script_cbor, stake_credential_hash
  ) values (
    p_community_id, p_token_hash, p_created_by, p_expires_at, v_name, p_workgroup_id,
    v_cbor, v_stake
  ) returning id into v_id;

  v_ord := 0;
  for v_elem in select value from jsonb_array_elements(p_signers)
  loop
    v_hash := lower(btrim(coalesce(v_elem->>'keyHash', '')));
    v_group := btrim(coalesce(v_elem->>'group', ''));
    if v_hash !~ '^[0-9a-f]{56}$' then
      raise exception 'Invalid signer key hash' using errcode = '22023';
    end if;
    if v_group not in ('base', 'recovery', 'cosigner') then
      raise exception 'Invalid signer group' using errcode = '22023';
    end if;
    if v_group = 'base' and v_hash = v_creator_hash then
      v_base_match := true;
    end if;

    insert into public.treasury_import_draft_signers (
      draft_id, position, key_hash, signer_group, wallet_address, display_name, claimed_at
    ) values (
      v_id,
      v_ord,
      v_hash,
      v_group,
      case when v_group = 'base' and v_hash = v_creator_hash then p_created_by else null end,
      nullif(btrim(coalesce(v_elem->>'name', '')), ''),
      case when v_group = 'base' and v_hash = v_creator_hash then now() else null end
    );
    v_ord := v_ord + 1;
  end loop;

  if not v_base_match then
    raise exception 'You must be a base signer of the treasury you are importing'
      using errcode = '22023';
  end if;

  return v_id;
end;
$fn$;

revoke all on function public.create_treasury_import_draft(
  uuid, text, text, text, text, uuid, timestamptz, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_treasury_import_draft(
  uuid, text, text, text, text, uuid, timestamptz, text, text, jsonb
) to service_role;

-- Rename / retarget workgroup. Signer slots stay fixed from the script.
create function public.save_treasury_import_draft(
  p_draft_id uuid,
  p_name text,
  p_workgroup_id uuid
) returns void
language plpgsql
set search_path = public
as $fn$
declare
  draft public.treasury_import_drafts%rowtype;
  v_name text;
begin
  select * into draft
  from public.treasury_import_drafts
  where id = p_draft_id
  for update;

  if not found or draft.expires_at <= now() then
    raise exception 'Import invite not found' using errcode = 'P0002';
  end if;

  v_name := btrim(p_name);
  if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 100 then
    raise exception 'Name the treasury' using errcode = '22023';
  end if;

  if p_workgroup_id is not null and not exists (
    select 1 from public.workgroups
    where id = p_workgroup_id and community_id = draft.community_id
  ) then
    raise exception 'Choose a workgroup of this community' using errcode = '22023';
  end if;

  update public.treasury_import_drafts
  set name = v_name,
      workgroup_id = p_workgroup_id
  where id = p_draft_id;
end;
$fn$;

revoke all on function public.save_treasury_import_draft(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.save_treasury_import_draft(uuid, text, uuid)
  to service_role;

-- Admin paste: set a slot's payment address. The app must have checked that
-- paymentKeyHash(address) equals the slot's key_hash.
create function public.set_treasury_import_draft_slot_address(
  p_draft_id uuid,
  p_key_hash text,
  p_wallet text,
  p_display_name text
) returns void
language plpgsql
set search_path = public
as $fn$
declare
  draft public.treasury_import_drafts%rowtype;
  v_hash text;
  v_wallet text;
  v_group text;
begin
  select * into draft
  from public.treasury_import_drafts
  where id = p_draft_id
  for update;

  if not found or draft.expires_at <= now() then
    raise exception 'Import invite not found' using errcode = 'P0002';
  end if;

  v_hash := nullif(lower(btrim(coalesce(p_key_hash, ''))), '');
  v_wallet := nullif(btrim(coalesce(p_wallet, '')), '');
  if v_hash is null or v_hash !~ '^[0-9a-f]{56}$' or v_wallet is null then
    raise exception 'Provide a payment address for this signer key' using errcode = '22023';
  end if;

  select signer_group into v_group
  from public.treasury_import_draft_signers
  where draft_id = p_draft_id and key_hash = v_hash
  for update;

  if not found then
    raise exception 'Unknown signer key on this import invite' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.treasury_import_draft_signers
    where draft_id = p_draft_id
      and wallet_address = v_wallet
      and key_hash <> v_hash
  ) then
    raise exception 'Duplicate signer addresses' using errcode = '22023';
  end if;

  if v_group in ('recovery', 'cosigner') and not exists (
    select 1 from public.community_members
    where community_id = draft.community_id and wallet_address = v_wallet
  ) then
    raise exception 'Recovery signers and the co-signer must already be community members'
      using errcode = '22023';
  end if;

  update public.treasury_import_draft_signers
  set wallet_address = v_wallet,
      display_name = coalesce(nullif(btrim(coalesce(p_display_name, '')), ''), display_name),
      claimed_at = now()
  where draft_id = p_draft_id and key_hash = v_hash;
end;
$fn$;

revoke all on function public.set_treasury_import_draft_slot_address(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_treasury_import_draft_slot_address(uuid, text, text, text)
  to service_role;

-- Invite link: look up by token hash, then claim.
create function public.claim_treasury_import_invite(
  p_token_hash text,
  p_wallet text,
  p_key_hash text,
  p_display_name text
) returns void
language plpgsql
set search_path = public
as $fn$
declare
  draft public.treasury_import_drafts%rowtype;
begin
  if p_token_hash is null or length(p_token_hash) = 0 then
    raise exception 'Import invite not found' using errcode = 'P0002';
  end if;

  select * into draft
  from public.treasury_import_drafts
  where token_hash = p_token_hash
  for update;

  if not found or draft.expires_at <= now() then
    raise exception 'Import invite not found' using errcode = 'P0002';
  end if;

  perform public.claim_treasury_import_draft_slot(
    draft.id, p_wallet, p_key_hash, p_display_name
  );
end;
$fn$;

revoke all on function public.claim_treasury_import_invite(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_treasury_import_invite(text, text, text, text)
  to service_role;

create function public.purge_treasury_import_drafts(p_now timestamptz)
returns integer
language plpgsql
set search_path = public
as $fn$
declare
  removed integer;
begin
  delete from public.treasury_import_drafts
  where expires_at < p_now;
  get diagnostics removed = row_count;
  return removed;
end;
$fn$;

revoke all on function public.purge_treasury_import_drafts(timestamptz)
  from public, anon, authenticated;
grant execute on function public.purge_treasury_import_drafts(timestamptz) to service_role;
