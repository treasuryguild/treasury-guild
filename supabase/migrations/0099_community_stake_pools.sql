-- Community stake pools: link a Cardano pool, cache registration params, map
-- role wallets, and book operator rewards as revenue once they reach a
-- community treasury (directly or via a pool_rewards float buffer).

-- 1. Float purpose (DEX vs pool rewards buffer) --------------------------------

alter table public.float_wallets
  add column purpose text not null default 'dex'
    check (purpose in ('dex', 'pool_rewards'));

comment on column public.float_wallets.purpose is
  'dex = DEX/dApp float; pool_rewards = watched buffer that only forwards SPO rewards to a treasury.';

-- 2. Community stake pools -----------------------------------------------------

create table public.community_stake_pools (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  pool_id text not null check (char_length(pool_id) between 1 and 128),
  ticker text check (ticker is null or char_length(ticker) between 1 and 16),
  margin numeric,
  fixed_cost text,
  pledge text,
  active_stake text,
  pool_status text not null default 'registered',
  reward_address text,
  owners text[] not null default '{}',
  funding_source_id uuid not null,
  refreshed_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by text,
  created_by text not null,
  created_at timestamptz not null default now(),
  foreign key (funding_source_id, community_id)
    references public.funding_sources(id, community_id) on delete restrict
);

-- One live link per pool; an archived row may be replaced by a new link.
create unique index community_stake_pools_active_uq
  on public.community_stake_pools(community_id, pool_id)
  where archived_at is null;

create index community_stake_pools_community_idx
  on public.community_stake_pools(community_id)
  where archived_at is null;

create index community_stake_pools_funding_idx
  on public.community_stake_pools(funding_source_id);

comment on table public.community_stake_pools is
  'Stake pools a community monitors for operator reward income.';

alter table public.community_stake_pools enable row level security;
create policy community_stake_pools_read on public.community_stake_pools
  for select using (public.is_member(community_id));
revoke all on public.community_stake_pools from anon, authenticated, service_role;
grant select on public.community_stake_pools to authenticated;
grant select, insert, update, delete on public.community_stake_pools to service_role;

-- 3. Role wallets --------------------------------------------------------------

create table public.stake_pool_wallets (
  id uuid primary key default gen_random_uuid(),
  stake_pool_id uuid not null references public.community_stake_pools(id) on delete cascade,
  role text not null check (role in (
    'reward_account', 'owner', 'operator_payment', 'rewards_buffer', 'community_treasury'
  )),
  address text check (address is null or char_length(address) between 1 and 200),
  float_wallet_id uuid references public.float_wallets(id) on delete cascade,
  treasury_id uuid references public.treasuries(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (
    (address is not null)::int
    + (float_wallet_id is not null)::int
    + (treasury_id is not null)::int
    = 1
  ),
  check (
    (role = 'rewards_buffer') = (float_wallet_id is not null)
  ),
  check (
    (role = 'community_treasury') = (treasury_id is not null)
  ),
  check (
    role in ('reward_account', 'owner', 'operator_payment') = (address is not null)
  )
);

create index stake_pool_wallets_pool_idx on public.stake_pool_wallets(stake_pool_id);
create index stake_pool_wallets_float_idx on public.stake_pool_wallets(float_wallet_id)
  where float_wallet_id is not null;
create index stake_pool_wallets_treasury_idx on public.stake_pool_wallets(treasury_id)
  where treasury_id is not null;

-- Rewards buffer must be a pool_rewards float of the same community; treasury
-- destination must belong to the same community.
create function public.guard_stake_pool_wallet() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_community uuid;
begin
  select community_id into v_community from community_stake_pools where id = new.stake_pool_id;
  if v_community is null then
    raise exception 'Stake pool not found' using errcode = '23503';
  end if;
  if new.float_wallet_id is not null then
    if not exists (
      select 1 from float_wallets f
      where f.id = new.float_wallet_id
        and f.community_id = v_community
        and f.purpose = 'pool_rewards'
    ) then
      raise exception 'Rewards buffer must be a pool_rewards float of this community'
        using errcode = '23514';
    end if;
  end if;
  if new.treasury_id is not null then
    if not exists (
      select 1 from treasuries t
      where t.id = new.treasury_id and t.community_id = v_community
    ) then
      raise exception 'Community treasury must belong to this community'
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger stake_pool_wallets_guard
  before insert or update on public.stake_pool_wallets
  for each row execute function public.guard_stake_pool_wallet();

alter table public.stake_pool_wallets enable row level security;
create policy stake_pool_wallets_read on public.stake_pool_wallets
  for select using (exists (
    select 1 from public.community_stake_pools p
    where p.id = stake_pool_id and public.is_member(p.community_id)
  ));
revoke all on public.stake_pool_wallets from anon, authenticated, service_role;
grant select on public.stake_pool_wallets to authenticated;
grant select, insert, update, delete on public.stake_pool_wallets to service_role;

-- 4. Incoming txs link ---------------------------------------------------------

alter table public.incoming_txs
  add column stake_pool_id uuid references public.community_stake_pools(id) on delete set null;

create index incoming_txs_stake_pool_idx on public.incoming_txs(stake_pool_id)
  where stake_pool_id is not null;

comment on column public.incoming_txs.stake_pool_id is
  'Set when this inflow is booked as operator rewards from a linked community stake pool.';

-- Allow funding_source on pool-reward forwards that still carry from_float_wallet_id
-- (sibling treasury transfers remain refused). Clear the tag if a later internal
-- transfer tag finds a from_treasury_id.
create or replace function public.guard_incoming_funding() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.funding_source_id is null then
    new.funding_commitment_id := null;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.from_treasury_id is not null
    and new.from_treasury_id is distinct from old.from_treasury_id then
    new.funding_source_id := null;
    new.funding_commitment_id := null;
    new.stake_pool_id := null;
    return new;
  end if;
  if new.from_treasury_id is not null then
    raise exception 'A transfer between your treasuries cannot be tied to a funding source'
      using errcode = '23514';
  end if;
  if not exists (select 1 from funding_sources s join treasuries t on t.community_id = s.community_id
      where s.id = new.funding_source_id and t.id = new.treasury_id) then
    raise exception 'That funding source belongs to another community' using errcode = '23514';
  end if;
  if new.funding_commitment_id is not null and not exists (select 1 from funding_commitments c
      where c.id = new.funding_commitment_id and c.source_id = new.funding_source_id) then
    raise exception 'That commitment belongs to another funding source' using errcode = '23514';
  end if;
  if new.stake_pool_id is not null and not exists (
    select 1 from community_stake_pools p
    where p.id = new.stake_pool_id
      and p.funding_source_id = new.funding_source_id
  ) then
    raise exception 'Stake pool does not match that funding source' using errcode = '23514';
  end if;
  return new;
end $$;

-- Re-bind the trigger so updates of stake_pool_id also run the guard.
drop trigger if exists incoming_txs_funding_guard on public.incoming_txs;
create trigger incoming_txs_funding_guard
  before insert or update of funding_source_id, funding_commitment_id, from_treasury_id, stake_pool_id
  on public.incoming_txs
  for each row execute function public.guard_incoming_funding();

-- 5. Reclassify pool_rewards float → treasury as revenue ------------------------

-- After tag_float_transfers marks a float→treasury edge as transfer, promote
-- inflows from pool_rewards buffers linked to a stake pool to revenue booked
-- against that pool's funding source (income once at the treasury).
create function public.classify_pool_reward_inflows(p_community_id uuid) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer := 0;
begin
  update incoming_txs i
    set incoming_type = 'revenue',
        funding_source_id = p.funding_source_id,
        stake_pool_id = p.id,
        requires_reconciliation = false,
        matched = true
    from float_wallets f
    join stake_pool_wallets w on w.float_wallet_id = f.id and w.role = 'rewards_buffer'
    join community_stake_pools p on p.id = w.stake_pool_id
    where i.from_float_wallet_id = f.id
      and f.community_id = p_community_id
      and f.purpose = 'pool_rewards'
      and p.community_id = p_community_id
      and p.archived_at is null
      and i.from_treasury_id is null
      and i.stake_pool_id is null
      and i.incoming_type in ('unclassified', 'transfer');
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.classify_pool_reward_inflows(uuid) from public, authenticated, anon;
grant execute on function public.classify_pool_reward_inflows(uuid) to service_role;
