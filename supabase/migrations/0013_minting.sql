-- Token minting: a third transaction kind plus an audit table describing what
-- each mint tx forges. Writes are service-role only (build-mint route);
-- members can read their community's mints.

alter table transactions drop constraint transactions_kind_check;
alter table transactions add constraint transactions_kind_check
  check (kind in ('payout', 'generic', 'mint'));

create table mints (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  community_id uuid not null references communities(id) on delete cascade,
  treasury_id uuid not null references treasuries(id) on delete cascade,
  asset_kind text not null check (asset_kind in ('ft', 'nft')),
  policy_id text not null check (policy_id ~ '^[0-9a-f]{56}$'),
  -- NativeScript JSON used as the forge script (treasury script, optionally
  -- wrapped with a "before" time lock).
  policy_script jsonb not null,
  -- Hex CBOR of the same forge script (CIP-26 registry "policy" field).
  policy_script_cbor text not null,
  -- null = open (treasury) policy; otherwise the absolute slot after which the
  -- policy can no longer mint, and its wall-clock equivalent for display.
  lock_slot bigint,
  lock_until timestamptz,
  asset_name text not null check (octet_length(asset_name) between 1 and 32),
  asset_name_hex text not null check (asset_name_hex ~ '^[0-9a-f]{2,64}$'),
  -- On-chain base units.
  quantity numeric not null check (quantity > 0),
  decimals int not null default 0 check (decimals between 0 and 12),
  ticker text,
  image_cid text,
  recipient text not null,
  -- The label-721 entry exactly as built into the tx.
  metadata jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (transaction_id, policy_id, asset_name_hex)
);

create index mints_community_idx on mints(community_id, created_at desc);
create index mints_policy_idx on mints(policy_id);

alter table mints enable row level security;
create policy mints_read on mints
  for select using (public.is_member(community_id));
