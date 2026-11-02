-- Watched float wallets: payment-key addresses a community tracks for DEX /
-- dApp floats. Not treasuries: the app never builds or signs from them. Admins
-- register an address; the reconcile sweep polls it like a treasury address
-- and tags treasury↔float movements as transfers (not income or spend).

-- 1. Float wallets -------------------------------------------------------------

create table public.float_wallets (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  address text not null,
  note text check (note is null or octet_length(note) <= 500),
  archived_at timestamptz,
  archived_by text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (community_id, address)
);

create index float_wallets_community_idx on public.float_wallets(community_id)
  where archived_at is null;

comment on table public.float_wallets is
  'Watched payment-key wallets for DEX/dApp floats. Not signable treasuries.';

alter table public.float_wallets enable row level security;
create policy float_wallets_read on public.float_wallets
  for select using (public.is_member(community_id));
revoke all on public.float_wallets from anon, authenticated, service_role;
grant select on public.float_wallets to authenticated;
grant select, insert, update, delete on public.float_wallets to service_role;

-- 2. Sync cursors --------------------------------------------------------------

create table public.float_sync_cursors (
  float_wallet_id uuid primary key references public.float_wallets(id) on delete cascade,
  last_block_height bigint not null default 0,
  synced_at timestamptz
);

revoke all on public.float_sync_cursors from anon, authenticated, service_role;
grant select, insert, update, delete on public.float_sync_cursors to service_role;

-- 3. Float activity ------------------------------------------------------------

create table public.float_incoming_txs (
  tx_hash text primary key,
  float_wallet_id uuid not null references public.float_wallets(id) on delete cascade,
  from_addresses text[] not null default '{}',
  amount_lovelace bigint not null,
  assets jsonb,
  block_time timestamptz,
  -- A community treasury among the inputs (tag_float_transfers).
  from_treasury_id uuid references public.treasuries(id) on delete set null,
  created_at timestamptz not null default now()
);

create index float_incoming_txs_wallet_time_idx
  on public.float_incoming_txs(float_wallet_id, block_time desc);
create index float_incoming_txs_from_treasury_idx
  on public.float_incoming_txs(from_treasury_id) where from_treasury_id is not null;

alter table public.float_incoming_txs enable row level security;
create policy float_incoming_txs_read on public.float_incoming_txs
  for select using (exists (
    select 1 from public.float_wallets f
    where f.id = float_wallet_id and public.is_member(f.community_id)
  ));
revoke all on public.float_incoming_txs from anon, authenticated, service_role;
grant select on public.float_incoming_txs to authenticated;
grant select, insert, update, delete on public.float_incoming_txs to service_role;

create table public.float_external_txs (
  tx_hash text primary key,
  float_wallet_id uuid not null references public.float_wallets(id) on delete cascade,
  block_height bigint not null,
  block_time timestamptz not null,
  fee_lovelace bigint not null,
  amount_lovelace bigint not null,
  assets jsonb,
  to_addresses text[] not null default '{}',
  -- A community treasury among the recipients (tag_float_transfers).
  to_treasury_id uuid references public.treasuries(id) on delete set null,
  created_at timestamptz not null default now()
);

create index float_external_txs_wallet_time_idx
  on public.float_external_txs(float_wallet_id, block_time desc);
create index float_external_txs_to_treasury_idx
  on public.float_external_txs(to_treasury_id) where to_treasury_id is not null;

alter table public.float_external_txs enable row level security;
create policy float_external_txs_read on public.float_external_txs
  for select using (exists (
    select 1 from public.float_wallets f
    where f.id = float_wallet_id and public.is_member(f.community_id)
  ));
revoke all on public.float_external_txs from anon, authenticated, service_role;
grant select on public.float_external_txs to authenticated;
grant select, insert, update, delete on public.float_external_txs to service_role;

-- 4. Treasury-side links + payments -------------------------------------------

alter table public.incoming_txs
  add column from_float_wallet_id uuid references public.float_wallets(id) on delete set null;
create index incoming_txs_from_float_idx on public.incoming_txs(from_float_wallet_id)
  where from_float_wallet_id is not null;

alter table public.external_txs
  add column to_float_wallet_id uuid references public.float_wallets(id) on delete set null;
create index external_txs_to_float_idx on public.external_txs(to_float_wallet_id)
  where to_float_wallet_id is not null;

alter table public.payments
  add column recipient_float_wallet_id uuid references public.float_wallets(id) on delete set null;

do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'public.payments'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%recipient_treasury_id%'
    and pg_get_constraintdef(oid) like '%budget_month%';
  if c is null then
    raise exception 'payments transfer/budget check constraint not found';
  end if;
  execute format('alter table public.payments drop constraint %I', c);
end $$;

alter table public.payments add constraint payments_transfer_budget_check check (
  (
    (recipient_treasury_id is null and recipient_float_wallet_id is null) = (budget_month is not null)
  )
  and (recipient_treasury_id is null or recipient_float_wallet_id is null)
);

comment on column public.payments.recipient_float_wallet_id is
  'Set when the recipient is a community float wallet: a transfer, no budget month.';

-- 5. Tagging RPC ---------------------------------------------------------------

-- Idempotent twin of tag_internal_transfers for treasury↔float edges. The
-- receiver's incoming row (treasury or float) is the amount source; the
-- sender's external row is tagged for display / outside-spend skip.
create function public.tag_float_transfers(p_community_id uuid) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer := 0;
  v_n integer;
begin
  -- Treasury inflow from a float of this community.
  update incoming_txs i
    set from_float_wallet_id = f.id,
        incoming_type = case when i.incoming_type = 'unclassified' and not i.matched
          then 'transfer' else i.incoming_type end,
        requires_reconciliation = case when i.incoming_type = 'unclassified' and not i.matched
          then false else i.requires_reconciliation end,
        matched = case when i.incoming_type = 'unclassified' and not i.matched
          then true else i.matched end
    from treasuries r, float_wallets f
    where r.id = i.treasury_id and r.community_id = p_community_id
      and f.community_id = p_community_id
      and f.address = any(i.from_addresses)
      and i.from_float_wallet_id is null
      and i.from_treasury_id is null;
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  -- Treasury outgoing to a float of this community.
  update external_txs e
    set to_float_wallet_id = f.id
    from treasuries r, float_wallets f
    where r.id = e.treasury_id and r.community_id = p_community_id
      and f.community_id = p_community_id
      and f.address = any(e.to_addresses)
      and e.to_float_wallet_id is null
      and e.to_treasury_id is null;
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  -- Float inflow from a treasury of this community.
  update float_incoming_txs i
    set from_treasury_id = t.id
    from float_wallets f, treasuries t
    where f.id = i.float_wallet_id and f.community_id = p_community_id
      and t.community_id = p_community_id
      and t.address = any(i.from_addresses)
      and i.from_treasury_id is null;
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  -- Float outgoing to a treasury of this community.
  update float_external_txs e
    set to_treasury_id = t.id
    from float_wallets f, treasuries t
    where f.id = e.float_wallet_id and f.community_id = p_community_id
      and t.community_id = p_community_id
      and t.address = any(e.to_addresses)
      and e.to_treasury_id is null;
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  return v_count;
end $$;

revoke all on function public.tag_float_transfers(uuid) from public, authenticated, anon;
grant execute on function public.tag_float_transfers(uuid) to service_role;
