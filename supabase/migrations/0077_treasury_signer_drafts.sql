-- SDK treasury signer invites: an admin lists payment addresses, each signer
-- connects and contributes a stake address (and optional DRep key hash), and
-- the treasury is created from those keys. The raw token is shown once; only
-- its sha256 is stored. Stake addresses live here only until the treasury is
-- created or the draft expires — the treasury keeps the stake key hash.
--
-- All writes are service-role. Members never read these rows.

create table public.treasury_signer_drafts (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  token_hash text not null unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  required int not null check (required >= 1),
  workgroup_id uuid references public.workgroups(id) on delete set null
);
create index treasury_signer_drafts_community_idx
  on public.treasury_signer_drafts (community_id, expires_at);

create table public.treasury_signer_draft_signers (
  draft_id uuid not null references public.treasury_signer_drafts(id) on delete cascade,
  position int not null check (position >= 0),
  wallet_address text not null check (length(btrim(wallet_address)) > 0),
  display_name text,
  stake_address text check (stake_address is null or length(stake_address) between 1 and 200),
  drep_key_hash text check (drep_key_hash is null or drep_key_hash ~ '^[0-9a-f]{56}$'),
  contributed_at timestamptz,
  primary key (draft_id, position),
  unique (draft_id, wallet_address)
);

alter table public.treasury_signer_drafts enable row level security;
alter table public.treasury_signer_draft_signers enable row level security;

revoke all on public.treasury_signer_drafts from anon, authenticated, service_role;
revoke all on public.treasury_signer_draft_signers from anon, authenticated, service_role;
grant select, insert, update, delete on public.treasury_signer_drafts to service_role;
grant select, insert, update, delete on public.treasury_signer_draft_signers to service_role;

-- Stake / DRep for one listed payment address. Caller must already hold the
-- draft row lock (contribute and save do). Unknown or expired drafts and a
-- wallet that is not listed are different errors: the invite page tells a
-- connected wallet when it is not on the list.
create function public.set_treasury_signer_draft_keys(
  p_draft_id uuid,
  p_wallet text,
  p_stake_address text,
  p_drep_key_hash text
) returns void
language plpgsql
set search_path = public
as $fn$
declare
  v_expires timestamptz;
  v_network int;
  v_drep text;
  v_updated int;
begin
  select d.expires_at, c.network
    into v_expires, v_network
  from public.treasury_signer_drafts d
  join public.communities c on c.id = d.community_id
  where d.id = p_draft_id;

  if not found or v_expires <= now() then
    raise exception 'Signer invite not found' using errcode = 'P0002';
  end if;

  if p_stake_address is null
     or length(p_stake_address) > 200
     or p_stake_address !~ '^stake(_test)?1[02-9ac-hj-np-z]+$' then
    raise exception 'Invalid stake address' using errcode = '22023';
  end if;

  -- Same rule as addressToNetwork: preprod addresses contain "test".
  if (v_network = 0) <> (strpos(p_stake_address, 'test') > 0) then
    raise exception 'Stake address is on the wrong network' using errcode = '22023';
  end if;

  v_drep := nullif(lower(btrim(coalesce(p_drep_key_hash, ''))), '');
  if v_drep is not null and v_drep !~ '^[0-9a-f]{56}$' then
    raise exception 'Invalid DRep key hash' using errcode = '22023';
  end if;

  update public.treasury_signer_draft_signers
  set stake_address = p_stake_address,
      drep_key_hash = v_drep,
      contributed_at = now()
  where draft_id = p_draft_id
    and wallet_address = p_wallet;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'This wallet is not a listed signer' using errcode = '22023';
  end if;
end;
$fn$;

revoke all on function public.set_treasury_signer_draft_keys(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_treasury_signer_draft_keys(uuid, text, text, text) to service_role;

-- Open a draft. Stake and DRep on the body are kept only for the creator's
-- own payment address; every other signer's keys stay empty until they connect.
create function public.create_treasury_signer_draft(
  p_community_id uuid,
  p_token_hash text,
  p_created_by text,
  p_name text,
  p_required int,
  p_workgroup_id uuid,
  p_expires_at timestamptz,
  p_signers jsonb
) returns uuid
language plpgsql
set search_path = public
as $fn$
declare
  v_id uuid;
  v_name text;
  v_count int;
  v_network int;
  v_elem jsonb;
  v_ord int;
  v_address text;
  v_stake text;
  v_drep text;
begin
  v_name := btrim(p_name);
  if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 100 then
    raise exception 'Name the treasury' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'Signer invite not found' using errcode = '22023';
  end if;

  v_count := coalesce(jsonb_array_length(p_signers), 0);
  if v_count < 1 or p_required is null or p_required < 1 or p_required > v_count then
    raise exception 'Required signatures must be between 1 and the number of signers' using errcode = '22023';
  end if;
  if (
    select count(distinct elem->>'address')
    from jsonb_array_elements(p_signers) elem
  ) <> v_count
  or exists (
    select 1 from jsonb_array_elements(p_signers) elem
    where coalesce(btrim(elem->>'address'), '') = ''
  ) then
    raise exception 'Duplicate signer addresses' using errcode = '22023';
  end if;

  if p_workgroup_id is not null and not exists (
    select 1 from public.workgroups
    where id = p_workgroup_id and community_id = p_community_id
  ) then
    raise exception 'Choose a workgroup of this community' using errcode = '22023';
  end if;

  if (
    select count(*) from public.treasury_signer_drafts
    where community_id = p_community_id and expires_at > now()
  ) >= 10 then
    raise exception 'This community already has 10 open SDK signer invites. Discard one first.'
      using errcode = '22023';
  end if;

  select network into v_network from public.communities where id = p_community_id;
  if not found then
    raise exception 'Signer invite not found' using errcode = 'P0002';
  end if;

  insert into public.treasury_signer_drafts (
    community_id, token_hash, created_by, expires_at, name, required, workgroup_id
  ) values (
    p_community_id, p_token_hash, p_created_by, p_expires_at, v_name, p_required, p_workgroup_id
  ) returning id into v_id;

  v_ord := 0;
  for v_elem in select value from jsonb_array_elements(p_signers)
  loop
    v_address := v_elem->>'address';
    v_stake := null;
    v_drep := null;
    if v_address = p_created_by then
      v_stake := nullif(v_elem->>'stakeAddress', '');
      v_drep := nullif(lower(btrim(coalesce(v_elem->>'drepKeyHash', ''))), '');
    end if;
    if v_stake is not null then
      if length(v_stake) > 200 or v_stake !~ '^stake(_test)?1[02-9ac-hj-np-z]+$' then
        raise exception 'Invalid stake address' using errcode = '22023';
      end if;
      if (v_network = 0) <> (strpos(v_stake, 'test') > 0) then
        raise exception 'Stake address is on the wrong network' using errcode = '22023';
      end if;
      if v_drep is not null and v_drep !~ '^[0-9a-f]{56}$' then
        raise exception 'Invalid DRep key hash' using errcode = '22023';
      end if;
    else
      v_drep := null;
    end if;

    insert into public.treasury_signer_draft_signers (
      draft_id, position, wallet_address, display_name, stake_address, drep_key_hash, contributed_at
    ) values (
      v_id,
      v_ord,
      v_address,
      nullif(btrim(coalesce(v_elem->>'name', '')), ''),
      v_stake,
      v_drep,
      case when v_stake is not null then now() else null end
    );
    v_ord := v_ord + 1;
  end loop;

  return v_id;
end;
$fn$;

revoke all on function public.create_treasury_signer_draft(uuid, text, text, text, int, uuid, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_treasury_signer_draft(uuid, text, text, text, int, uuid, timestamptz, jsonb)
  to service_role;

-- Replace the signer list. Keys stay with a payment address that is still
-- listed and are dropped when that address is removed. p_stake_address, when
-- set, is written only onto p_actor's row.
create function public.save_treasury_signer_draft(
  p_draft_id uuid,
  p_name text,
  p_required int,
  p_workgroup_id uuid,
  p_signers jsonb,
  p_actor text,
  p_stake_address text,
  p_drep_key_hash text
) returns void
language plpgsql
set search_path = public
as $fn$
declare
  draft public.treasury_signer_drafts%rowtype;
  v_name text;
  v_count int;
  kept jsonb;
begin
  select * into draft
  from public.treasury_signer_drafts
  where id = p_draft_id
  for update;

  if not found or draft.expires_at <= now() then
    raise exception 'Signer invite not found' using errcode = 'P0002';
  end if;

  v_name := btrim(p_name);
  if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 100 then
    raise exception 'Name the treasury' using errcode = '22023';
  end if;

  v_count := coalesce(jsonb_array_length(p_signers), 0);
  if v_count < 1 or p_required is null or p_required < 1 or p_required > v_count then
    raise exception 'Required signatures must be between 1 and the number of signers' using errcode = '22023';
  end if;
  if (
    select count(distinct elem->>'address')
    from jsonb_array_elements(p_signers) elem
  ) <> v_count
  or exists (
    select 1 from jsonb_array_elements(p_signers) elem
    where coalesce(btrim(elem->>'address'), '') = ''
  ) then
    raise exception 'Duplicate signer addresses' using errcode = '22023';
  end if;

  if p_workgroup_id is not null and not exists (
    select 1 from public.workgroups
    where id = p_workgroup_id and community_id = draft.community_id
  ) then
    raise exception 'Choose a workgroup of this community' using errcode = '22023';
  end if;

  select coalesce(jsonb_object_agg(
    wallet_address,
    jsonb_build_object(
      'stake', stake_address,
      'drep', drep_key_hash,
      'at', contributed_at
    )
  ), '{}'::jsonb)
  into kept
  from public.treasury_signer_draft_signers
  where draft_id = p_draft_id;

  update public.treasury_signer_drafts
  set name = v_name,
      required = p_required,
      workgroup_id = p_workgroup_id
  where id = p_draft_id;

  delete from public.treasury_signer_draft_signers where draft_id = p_draft_id;

  insert into public.treasury_signer_draft_signers (
    draft_id, position, wallet_address, display_name, stake_address, drep_key_hash, contributed_at
  )
  select
    p_draft_id,
    (t.ord - 1)::int,
    t.elem->>'address',
    nullif(btrim(coalesce(t.elem->>'name', '')), ''),
    kept -> (t.elem->>'address') ->> 'stake',
    kept -> (t.elem->>'address') ->> 'drep',
    nullif(kept -> (t.elem->>'address') ->> 'at', '')::timestamptz
  from jsonb_array_elements(p_signers) with ordinality as t(elem, ord);

  if p_stake_address is not null and p_stake_address <> '' then
    perform public.set_treasury_signer_draft_keys(
      p_draft_id, p_actor, p_stake_address, p_drep_key_hash
    );
  end if;
end;
$fn$;

revoke all on function public.save_treasury_signer_draft(uuid, text, int, uuid, jsonb, text, text, text)
  from public, anon, authenticated;
grant execute on function public.save_treasury_signer_draft(uuid, text, int, uuid, jsonb, text, text, text)
  to service_role;

-- The connected wallet writes its own stake address and optional DRep hash.
-- Expired and unknown tokens are the same not-found error.
create function public.contribute_treasury_signer_keys(
  p_token_hash text,
  p_wallet text,
  p_stake_address text,
  p_drep_key_hash text
) returns void
language plpgsql
set search_path = public
as $fn$
declare
  draft public.treasury_signer_drafts%rowtype;
begin
  if p_token_hash is null or length(p_token_hash) = 0 or p_wallet is null or length(p_wallet) = 0 then
    raise exception 'Signer invite not found' using errcode = 'P0002';
  end if;

  select * into draft
  from public.treasury_signer_drafts
  where token_hash = p_token_hash
  for update;

  if not found or draft.expires_at <= now() then
    raise exception 'Signer invite not found' using errcode = 'P0002';
  end if;

  perform public.set_treasury_signer_draft_keys(
    draft.id, p_wallet, p_stake_address, p_drep_key_hash
  );
end;
$fn$;

revoke all on function public.contribute_treasury_signer_keys(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.contribute_treasury_signer_keys(text, text, text, text) to service_role;

-- Drop drafts once they have expired. Signer rows cascade. A draft the
-- treasury was created from is deleted immediately by the app.
create function public.purge_treasury_signer_drafts(p_now timestamptz)
returns integer
language plpgsql
set search_path = public
as $fn$
declare
  removed integer;
begin
  delete from public.treasury_signer_drafts
  where expires_at < p_now;
  get diagnostics removed = row_count;
  return removed;
end;
$fn$;

revoke all on function public.purge_treasury_signer_drafts(timestamptz)
  from public, anon, authenticated;
grant execute on function public.purge_treasury_signer_drafts(timestamptz) to service_role;
