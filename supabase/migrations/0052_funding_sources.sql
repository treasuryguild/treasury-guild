-- Funding sources: outside funders (a grant treasury that releases money to
-- several communities, Project Catalyst, a sponsor) and what they committed,
-- compared with the inflows an admin ties to them. Nothing here is read from
-- the chain: received amounts are the community's own incoming_txs rows,
-- tagged whole on the Incoming page. Planned amounts are base units per token,
-- in the shape budget amounts use: [{unit, amount, asset_label, decimals}].

-- 1. Sources and commitments ------------------------------------------------------

create table public.funding_sources (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (description is null or char_length(description) <= 500),
  url text check (url is null or (char_length(url) <= 500 and url ~* '^https?://\S+$')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, community_id)
);
create unique index funding_sources_name_uq on public.funding_sources(community_id, lower(name));

create function public.funding_amounts_valid(p jsonb) returns boolean
language sql immutable set search_path = public as $$
  select jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 20 and not exists (
    select 1 from jsonb_array_elements(p) a where
      jsonb_typeof(a) <> 'object'
      or coalesce(a->>'unit', '') !~ '^(lovelace|[0-9a-f]{56,120})$'
      or coalesce(a->>'amount', '') !~ '^[1-9][0-9]{0,37}$'
      or coalesce(a->>'decimals', '') !~ '^([0-9]|[12][0-9]|30)$'
  ) and (select count(*) = count(distinct a->>'unit') from jsonb_array_elements(p) a)
$$;

-- one_off: a total, `starts_on` = the month it is expected (optional).
-- recurring: `amounts` every period from `starts_on` to `ends_on` (null = open-ended).
-- schedule: each period's amounts in funding_commitment_periods.
create table public.funding_commitments (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null,
  community_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  url text check (url is null or (char_length(url) <= 500 and url ~* '^https?://\S+$')),
  note text check (note is null or char_length(note) <= 500),
  kind text not null check (kind in ('one_off', 'recurring', 'schedule')),
  cadence text check (cadence in ('monthly', 'quarterly')),
  starts_on date check (starts_on is null or extract(day from starts_on) = 1),
  ends_on date check (ends_on is null or extract(day from ends_on) = 1),
  amounts jsonb not null default '[]' check (public.funding_amounts_valid(amounts)),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (source_id, community_id) references public.funding_sources(id, community_id) on delete cascade,
  check ((kind = 'one_off') = (cadence is null)),
  check (kind = 'recurring' or ends_on is null),
  check (kind <> 'recurring' or starts_on is not null),
  check (kind <> 'schedule' or starts_on is null),
  check ((kind = 'schedule') = (jsonb_array_length(amounts) = 0)),
  check (ends_on is null or ends_on >= starts_on),
  check (cadence is distinct from 'quarterly' or (
    (starts_on is null or extract(month from starts_on) in (1, 4, 7, 10)) and
    (ends_on is null or extract(month from ends_on) in (1, 4, 7, 10))))
);
create index funding_commitments_source_idx on public.funding_commitments(source_id);

create table public.funding_commitment_periods (
  commitment_id uuid not null references public.funding_commitments(id) on delete cascade,
  starts_on date not null check (extract(day from starts_on) = 1),
  amounts jsonb not null check (public.funding_amounts_valid(amounts) and jsonb_array_length(amounts) > 0),
  primary key (commitment_id, starts_on)
);

-- 2. Tagging inflows ----------------------------------------------------------------

alter table public.incoming_txs
  add column funding_source_id uuid references public.funding_sources(id) on delete set null,
  add column funding_commitment_id uuid references public.funding_commitments(id) on delete set null;
create index incoming_txs_funding_source_idx on public.incoming_txs(funding_source_id)
  where funding_source_id is not null;

-- A commitment needs its own source; the source is the treasury's community's;
-- money from another of the community's treasuries is a transfer, never funding.
create function public.guard_incoming_funding() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.funding_source_id is null then
    new.funding_commitment_id := null;
    return new;
  end if;
  -- tag_internal_transfers found the sender among the community's treasuries
  -- after the inflow was tagged: it is a transfer now, so the tag goes.
  if tg_op = 'UPDATE' and new.from_treasury_id is not null
    and new.from_treasury_id is distinct from old.from_treasury_id then
    new.funding_source_id := null;
    new.funding_commitment_id := null;
    return new;
  end if;
  if new.from_treasury_id is not null then
    raise exception 'A transfer between your treasuries cannot be tied to a funding source' using errcode = '23514';
  end if;
  if not exists (select 1 from funding_sources s join treasuries t on t.community_id = s.community_id
      where s.id = new.funding_source_id and t.id = new.treasury_id) then
    raise exception 'That funding source belongs to another community' using errcode = '23514';
  end if;
  if new.funding_commitment_id is not null and not exists (select 1 from funding_commitments c
      where c.id = new.funding_commitment_id and c.source_id = new.funding_source_id) then
    raise exception 'That commitment belongs to another funding source' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger incoming_txs_funding_guard
  before insert or update of funding_source_id, funding_commitment_id, from_treasury_id on public.incoming_txs
  for each row execute function public.guard_incoming_funding();

-- 3. Schedules ----------------------------------------------------------------------

-- Replace every period of a schedule in one statement: a refused period keeps
-- the old schedule. p_periods: [{startsOn: 'YYYY-MM-DD', amounts: [...]}].
create function public.save_funding_schedule(p_commitment_id uuid, p_periods jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  c public.funding_commitments;
  v_count integer;
begin
  select * into c from funding_commitments where id = p_commitment_id for update;
  if not found then raise exception 'Commitment not found' using errcode = 'P0002'; end if;
  if c.kind <> 'schedule' then
    raise exception 'Only a schedule has periods' using errcode = '23514';
  end if;
  if jsonb_typeof(p_periods) is distinct from 'array' or jsonb_array_length(p_periods) > 600 then
    raise exception 'A schedule has at most 600 periods' using errcode = '23514';
  end if;
  if c.cadence = 'quarterly' and exists (select 1 from jsonb_array_elements(p_periods) p
      where extract(month from (p->>'startsOn')::date) not in (1, 4, 7, 10)) then
    raise exception 'A quarterly schedule has periods starting in January, April, July or October' using errcode = '23514';
  end if;
  delete from funding_commitment_periods where commitment_id = c.id;
  insert into funding_commitment_periods(commitment_id, starts_on, amounts)
    select c.id, (p->>'startsOn')::date, p->'amounts' from jsonb_array_elements(p_periods) p;
  get diagnostics v_count = row_count;
  update funding_commitments set updated_at = now() where id = c.id;
  return v_count;
end $$;
revoke all on function public.save_funding_schedule(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_funding_schedule(uuid, jsonb) to service_role;

-- 4. Access: members read, service-role routes write ---------------------------------

alter table public.funding_sources enable row level security;
alter table public.funding_commitments enable row level security;
alter table public.funding_commitment_periods enable row level security;
create policy funding_sources_read on public.funding_sources for select
  using (public.is_member(community_id));
create policy funding_commitments_read on public.funding_commitments for select
  using (public.is_member(community_id));
create policy funding_commitment_periods_read on public.funding_commitment_periods for select
  using (exists (select 1 from public.funding_commitments c
    where c.id = commitment_id and public.is_member(c.community_id)));
revoke all on public.funding_sources, public.funding_commitments, public.funding_commitment_periods
  from anon, authenticated, service_role;
grant select on public.funding_sources, public.funding_commitments, public.funding_commitment_periods
  to authenticated;
grant select, insert, update, delete on public.funding_sources, public.funding_commitments,
  public.funding_commitment_periods to service_role;
