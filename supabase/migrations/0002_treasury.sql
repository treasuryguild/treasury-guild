-- Multisig treasuries, signers, pending/submitted transactions

create table treasuries (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities(id) on delete cascade,
  name text not null,
  network smallint not null check (network in (0, 1)),
  required smallint not null check (required >= 1),
  script_type text not null default 'atLeast' check (script_type in ('atLeast', 'all', 'any')),
  address text not null unique,
  script_cbor text not null,
  stake_credential_hash text,
  created_at timestamptz not null default now()
);

create table treasury_signers (
  treasury_id uuid not null references treasuries(id) on delete cascade,
  wallet_address text not null,
  key_hash text not null,
  stake_key_hash text,
  display_name text,
  primary key (treasury_id, key_hash)
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  treasury_id uuid not null references treasuries(id) on delete cascade,
  kind text not null default 'payout' check (kind in ('payout', 'generic')),
  tx_cbor text not null,
  tx_hash text,
  description text,
  signed_addresses text[] not null default '{}',
  rejected_addresses text[] not null default '{}',
  -- 0=pending, 1=submitted, 2=confirmed, 3=rejected
  state smallint not null default 0 check (state in (0, 1, 2, 3)),
  created_by text not null,
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);

create index transactions_treasury_state_idx on transactions(treasury_id, state);

-- Optimistic-concurrency witness append: succeeds only if the caller signed
-- against the tx_cbor version it read (expected = signature count at read time).
create function add_signature(p_tx uuid, p_addr text, p_cbor text, p_expected int)
returns boolean
language sql
security definer
set search_path = public
as $$
  update transactions
  set tx_cbor = p_cbor,
      signed_addresses = array_append(signed_addresses, p_addr)
  where id = p_tx
    and state = 0
    and cardinality(signed_addresses) = p_expected
    and not (p_addr = any(signed_addresses))
  returning true;
$$;
