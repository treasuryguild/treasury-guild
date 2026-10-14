-- Core: contributors, communities, membership, auth nonces

create table contributors (
  wallet_address text primary key,
  handle text unique,
  github_username text,
  created_at timestamptz not null default now()
);

create table communities (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null,
  description text,
  network smallint not null default 0 check (network in (0, 1)),
  created_by text not null references contributors(wallet_address),
  created_at timestamptz not null default now()
);

create table community_members (
  community_id uuid not null references communities(id) on delete cascade,
  wallet_address text not null references contributors(wallet_address),
  role text not null check (role in ('owner', 'admin', 'signer', 'member')),
  created_at timestamptz not null default now(),
  primary key (community_id, wallet_address)
);

create table auth_nonces (
  address text primary key,
  nonce text not null,
  expires_at timestamptz not null default now() + interval '5 minutes'
);
