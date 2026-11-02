-- Bridge / swap conversion episodes: admin-written bookkeeping attached to a
-- Cardano treasury or float inflow. Fees and foreign-chain tx proofs live here;
-- they never charge workgroup or treasury budgets.

-- 1. Episodes --------------------------------------------------------------------

create table public.incoming_conversions (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  kind text not null check (kind in ('bridge', 'swap')),
  -- Exactly one Cardano inflow attach point.
  incoming_tx_hash text references public.incoming_txs(tx_hash) on delete cascade,
  float_incoming_tx_hash text references public.float_incoming_txs(tx_hash) on delete cascade,
  -- What was sent before conversion (manual; received amounts stay on the inflow).
  sent_amount text not null check (sent_amount ~ '^\d+(\.\d{1,30})?$' and sent_amount !~ '^0+(\.0+)?$'),
  sent_asset_label text not null check (char_length(btrim(sent_asset_label)) between 1 and 32),
  sent_chain text not null check (sent_chain in ('ethereum', 'cardano', 'bitcoin', 'other')),
  sent_address text check (sent_address is null or char_length(sent_address) between 1 and 200),
  note text check (note is null or octet_length(note) <= 1000),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (incoming_tx_hash is not null and float_incoming_tx_hash is null)
    or (incoming_tx_hash is null and float_incoming_tx_hash is not null)
  )
);

create unique index incoming_conversions_incoming_tx_uq
  on public.incoming_conversions(incoming_tx_hash) where incoming_tx_hash is not null;
create unique index incoming_conversions_float_incoming_tx_uq
  on public.incoming_conversions(float_incoming_tx_hash) where float_incoming_tx_hash is not null;
create index incoming_conversions_community_idx on public.incoming_conversions(community_id);

comment on table public.incoming_conversions is
  'Admin bridge/swap bookkeeping for a Cardano treasury or float inflow.';

alter table public.incoming_conversions enable row level security;
create policy incoming_conversions_read on public.incoming_conversions
  for select using (public.is_member(community_id));
revoke all on public.incoming_conversions from anon, authenticated, service_role;
grant select on public.incoming_conversions to authenticated;
grant select, insert, update, delete on public.incoming_conversions to service_role;

-- 2. Fee lines -------------------------------------------------------------------

create table public.incoming_conversion_fees (
  id uuid primary key default gen_random_uuid(),
  conversion_id uuid not null references public.incoming_conversions(id) on delete cascade,
  kind text not null check (kind in ('gas', 'bridge', 'spread', 'other')),
  amount text not null check (amount ~ '^\d+(\.\d{1,30})?$' and amount !~ '^0+(\.0+)?$'),
  asset_label text not null check (char_length(btrim(asset_label)) between 1 and 32),
  chain text check (chain is null or chain in ('ethereum', 'cardano', 'bitcoin', 'other')),
  position int not null default 0 check (position >= 0 and position < 50)
);

create index incoming_conversion_fees_conversion_idx
  on public.incoming_conversion_fees(conversion_id, position);

alter table public.incoming_conversion_fees enable row level security;
create policy incoming_conversion_fees_read on public.incoming_conversion_fees
  for select using (exists (
    select 1 from public.incoming_conversions c
    where c.id = conversion_id and public.is_member(c.community_id)
  ));
revoke all on public.incoming_conversion_fees from anon, authenticated, service_role;
grant select on public.incoming_conversion_fees to authenticated;
grant select, insert, update, delete on public.incoming_conversion_fees to service_role;

-- 3. Proof hashes ----------------------------------------------------------------

create table public.incoming_conversion_proofs (
  id uuid primary key default gen_random_uuid(),
  conversion_id uuid not null references public.incoming_conversions(id) on delete cascade,
  chain text not null check (chain in ('ethereum', 'cardano', 'bitcoin', 'other')),
  tx_hash text not null check (char_length(btrim(tx_hash)) between 1 and 128),
  url text check (url is null or (char_length(url) <= 500 and url ~* '^https?://\S+$')),
  label text check (label is null or char_length(label) <= 80),
  position int not null default 0 check (position >= 0 and position < 50)
);

create index incoming_conversion_proofs_conversion_idx
  on public.incoming_conversion_proofs(conversion_id, position);

alter table public.incoming_conversion_proofs enable row level security;
create policy incoming_conversion_proofs_read on public.incoming_conversion_proofs
  for select using (exists (
    select 1 from public.incoming_conversions c
    where c.id = conversion_id and public.is_member(c.community_id)
  ));
revoke all on public.incoming_conversion_proofs from anon, authenticated, service_role;
grant select on public.incoming_conversion_proofs to authenticated;
grant select, insert, update, delete on public.incoming_conversion_proofs to service_role;
