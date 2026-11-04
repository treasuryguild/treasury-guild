-- Previous-wallet receipts: income the old wallet received before Treasury Guild,
-- plus agent_import_payloads.kind = 'legacy_receipts' for the assistant import.

-- imported from a CSV the community audited itself. Parallel to payment history
-- (0050): the old address is never polled. Rows feed the Dashboard funding flow
-- into the previous wallet and count toward Funding "Received" when tied to a
-- funding source. Planned in TypeScript (src/lib/legacyHistory/receipt*) and
-- written only by import_legacy_receipts / import_agent_legacy_receipts.

-- 0. Agent payload kind ----------------------------------------------------------

do $$
declare
  c name;
begin
  select conname into c from pg_constraint
    where conrelid = 'public.agent_import_payloads'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%legacy_history%';
  if c is null then
    raise exception 'agent_import_payloads kind check not found';
  end if;
  execute format('alter table public.agent_import_payloads drop constraint %I', c);
end $$;
alter table public.agent_import_payloads add constraint agent_import_payloads_kind_check
  check (kind in ('legacy_history', 'funding_schedule', 'legacy_receipts'));

-- 1. Tables ----------------------------------------------------------------------

create table public.legacy_receipt_imports (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  legacy_wallet_id uuid not null references public.legacy_wallets(id) on delete cascade,
  file_name text not null check (octet_length(file_name) between 1 and 255),
  line_count integer not null check (line_count between 1 and 20000),
  created_by text not null,
  created_at timestamptz not null default now(),
  agent_draft_id text check (agent_draft_id is null or agent_draft_id ~ '^[0-9a-f]{32}$')
);
create index legacy_receipt_imports_wallet_idx on public.legacy_receipt_imports(legacy_wallet_id);
create unique index legacy_receipt_imports_draft_uq on public.legacy_receipt_imports(agent_draft_id)
  where agent_draft_id is not null;

create table public.legacy_receipts (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.legacy_receipt_imports(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  legacy_wallet_id uuid not null references public.legacy_wallets(id) on delete cascade,
  received_on date not null,
  funding_source_id uuid references public.funding_sources(id) on delete set null,
  funding_commitment_id uuid references public.funding_commitments(id) on delete set null,
  note text check (note is null or char_length(note) between 1 and 500),
  line_no integer not null check (line_no > 1),
  dedupe_key text not null check (dedupe_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (import_id, line_no),
  check (funding_commitment_id is null or funding_source_id is not null)
);
create index legacy_receipts_received_idx on public.legacy_receipts(community_id, received_on);
create index legacy_receipts_dedupe_idx on public.legacy_receipts(legacy_wallet_id, dedupe_key);
create index legacy_receipts_funding_idx on public.legacy_receipts(funding_source_id)
  where funding_source_id is not null;

create table public.legacy_receipt_amounts (
  receipt_id uuid not null references public.legacy_receipts(id) on delete cascade,
  unit text not null check (unit = 'lovelace' or unit ~ '^[0-9a-f]{56,120}$'),
  ticker text not null check (octet_length(ticker) between 1 and 32),
  decimals integer not null check (decimals between 0 and 30),
  amount numeric not null check (amount > 0 and amount = trunc(amount)),
  check (unit <> 'lovelace' or decimals = 6),
  primary key (receipt_id, unit)
);

alter table public.legacy_receipt_imports enable row level security;
alter table public.legacy_receipts enable row level security;
alter table public.legacy_receipt_amounts enable row level security;
revoke all on public.legacy_receipt_imports, public.legacy_receipts, public.legacy_receipt_amounts
  from anon, authenticated, service_role;
grant select, insert, update, delete on public.legacy_receipt_imports, public.legacy_receipts,
  public.legacy_receipt_amounts to service_role;

-- Commitment must belong to the receipt's funding source (and that source to the community).
create function public.guard_legacy_receipt_funding() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.funding_source_id is null then
    new.funding_commitment_id := null;
    return new;
  end if;
  if not exists (select 1 from funding_sources s
      where s.id = new.funding_source_id and s.community_id = new.community_id) then
    raise exception 'That funding source belongs to another community' using errcode = '23514';
  end if;
  if new.funding_commitment_id is not null and not exists (select 1 from funding_commitments c
      where c.id = new.funding_commitment_id and c.source_id = new.funding_source_id) then
    raise exception 'That commitment belongs to another funding source' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger legacy_receipts_funding_guard
  before insert or update of funding_source_id, funding_commitment_id, community_id on public.legacy_receipts
  for each row execute function public.guard_legacy_receipt_funding();

-- 2. Admin import ----------------------------------------------------------------

-- p_rows: [{ lineNo, receivedOn, fundingSourceId?, fundingCommitmentId?, note?,
--            dedupeKey, amounts: [{ unit, ticker, decimals, amount }] }]
create function public.import_legacy_receipts(
  p_legacy_wallet_id uuid,
  p_file_name text,
  p_actor text,
  p_rows jsonb,
  p_replace_import_id uuid default null,
  p_skip_existing boolean default true
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  w public.legacy_wallets;
  v_import uuid;
  v_total integer;
  v_inserted integer;
begin
  select * into w from legacy_wallets where id = p_legacy_wallet_id for update;
  if not found then raise exception 'Previous wallet not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from community_members where community_id = w.community_id
    and wallet_address = p_actor and role in ('owner', 'admin')) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Rows must be a list' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total < 1 or v_total > 20000 then
    raise exception 'An import carries 1 to 20000 rows' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
    where jsonb_typeof(r->'amounts') is distinct from 'array' or jsonb_array_length(r->'amounts') = 0) then
    raise exception 'Every row needs an amount' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
    where r->>'fundingSourceId' is not null
      and not exists (select 1 from funding_sources s
        where s.id = (r->>'fundingSourceId')::uuid and s.community_id = w.community_id)) then
    raise exception 'That funding source belongs to another community' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
    where r->>'fundingCommitmentId' is not null
      and (r->>'fundingSourceId' is null
        or not exists (select 1 from funding_commitments c
          where c.id = (r->>'fundingCommitmentId')::uuid
            and c.source_id = (r->>'fundingSourceId')::uuid))) then
    raise exception 'That commitment belongs to another funding source' using errcode = '23514';
  end if;

  if p_replace_import_id is not null then
    delete from legacy_receipt_imports where id = p_replace_import_id and legacy_wallet_id = w.id;
    if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  end if;

  insert into legacy_receipt_imports(community_id, legacy_wallet_id, file_name, line_count, created_by)
    values (w.community_id, w.id, p_file_name, v_total, p_actor)
    returning id into v_import;

  with src as (
    select r from jsonb_array_elements(p_rows) r
  ), ins as (
    insert into legacy_receipts(import_id, community_id, legacy_wallet_id, received_on,
      funding_source_id, funding_commitment_id, note, line_no, dedupe_key)
    select v_import, w.community_id, w.id, (r->>'receivedOn')::date,
      nullif(r->>'fundingSourceId', '')::uuid, nullif(r->>'fundingCommitmentId', '')::uuid,
      nullif(r->>'note', ''), (r->>'lineNo')::integer, r->>'dedupeKey'
    from src
    where not p_skip_existing or not exists (select 1 from legacy_receipts e
      where e.legacy_wallet_id = w.id and e.dedupe_key = src.r->>'dedupeKey')
    returning id, line_no
  ), amounts as (
    insert into legacy_receipt_amounts(receipt_id, unit, ticker, decimals, amount)
    select ins.id, a->>'unit', a->>'ticker', (a->>'decimals')::integer, (a->>'amount')::numeric
    from ins
    join src on (src.r->>'lineNo')::integer = ins.line_no
    cross join lateral jsonb_array_elements(src.r->'amounts') a
    returning 1
  )
  select count(*) into v_inserted from ins;

  if v_inserted = 0 then
    raise exception 'Nothing new to import: every row is already here' using errcode = '23514';
  end if;
  update legacy_receipt_imports set line_count = v_inserted where id = v_import;
  return jsonb_build_object(
    'importId', v_import,
    'inserted', v_inserted,
    'skipped', v_total - v_inserted,
    'replaced', p_replace_import_id is not null
  );
end $$;

revoke all on function public.import_legacy_receipts(uuid, text, text, jsonb, uuid, boolean)
  from public, authenticated, anon;
grant execute on function public.import_legacy_receipts(uuid, text, text, jsonb, uuid, boolean)
  to service_role;

-- 3. Agent import ----------------------------------------------------------------

create function public.import_agent_legacy_receipts(
  p_draft_id text,
  p_community_id uuid,
  p_actor text,
  p_file_name text,
  p_legacy_wallet_id uuid,
  p_wallet_name text,
  p_wallet_address text,
  p_rows jsonb,
  p_skip_existing boolean
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  w public.legacy_wallets;
  v_existing public.legacy_receipt_imports;
  v_import uuid;
  v_total integer;
  v_inserted integer;
begin
  if p_draft_id !~ '^[0-9a-f]{32}$' then
    raise exception 'Draft id is not valid' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtext('treasury-guild/agent-receipt-import'), hashtext(p_draft_id));

  if not exists (select 1 from community_members where community_id = p_community_id
    and wallet_address = p_actor and role in ('owner', 'admin')) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;

  select * into v_existing from legacy_receipt_imports where agent_draft_id = p_draft_id;
  if found then
    if v_existing.community_id <> p_community_id then
      raise exception 'This draft belongs to another community' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'importId', v_existing.id,
      'legacyWalletId', v_existing.legacy_wallet_id,
      'inserted', v_existing.line_count,
      'skipped', 0,
      'created', false
    );
  end if;

  if octet_length(coalesce(p_file_name, '')) < 1 or octet_length(p_file_name) > 255 then
    raise exception 'Name the file' using errcode = '23514';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Rows must be a list' using errcode = '23514';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total < 1 or v_total > 20000 then
    raise exception 'An import carries 1 to 20000 rows' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
    where jsonb_typeof(r->'amounts') is distinct from 'array' or jsonb_array_length(r->'amounts') = 0) then
    raise exception 'Every row needs an amount' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
    where r->>'fundingSourceId' is not null
      and not exists (select 1 from funding_sources s
        where s.id = (r->>'fundingSourceId')::uuid and s.community_id = p_community_id)) then
    raise exception 'That funding source belongs to another community' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
    where r->>'fundingCommitmentId' is not null
      and (r->>'fundingSourceId' is null
        or not exists (select 1 from funding_commitments c
          where c.id = (r->>'fundingCommitmentId')::uuid
            and c.source_id = (r->>'fundingSourceId')::uuid))) then
    raise exception 'That commitment belongs to another funding source' using errcode = '23514';
  end if;

  if p_legacy_wallet_id is not null then
    select * into w from legacy_wallets where id = p_legacy_wallet_id for update;
    if not found or w.community_id <> p_community_id then
      raise exception 'Previous wallet not found' using errcode = 'P0002';
    end if;
  else
    if char_length(btrim(coalesce(p_wallet_name, ''))) < 1 then
      raise exception 'Name the previous wallet' using errcode = '23514';
    end if;
    begin
      insert into legacy_wallets(community_id, name, address, created_by)
        values (p_community_id, btrim(p_wallet_name), nullif(btrim(coalesce(p_wallet_address, '')), ''), p_actor)
        returning * into w;
    exception when unique_violation then
      raise exception 'This community already has a previous wallet with that name' using errcode = '23505';
    end;
  end if;

  insert into legacy_receipt_imports(community_id, legacy_wallet_id, file_name, line_count, created_by, agent_draft_id)
    values (w.community_id, w.id, p_file_name, v_total, p_actor, p_draft_id)
    returning id into v_import;

  with src as (
    select r from jsonb_array_elements(p_rows) r
  ), ins as (
    insert into legacy_receipts(import_id, community_id, legacy_wallet_id, received_on,
      funding_source_id, funding_commitment_id, note, line_no, dedupe_key)
    select v_import, w.community_id, w.id, (r->>'receivedOn')::date,
      nullif(r->>'fundingSourceId', '')::uuid, nullif(r->>'fundingCommitmentId', '')::uuid,
      nullif(r->>'note', ''), (r->>'lineNo')::integer, r->>'dedupeKey'
    from src
    where not p_skip_existing or not exists (select 1 from legacy_receipts e
      where e.legacy_wallet_id = w.id and e.dedupe_key = src.r->>'dedupeKey')
    returning id, line_no
  ), amounts as (
    insert into legacy_receipt_amounts(receipt_id, unit, ticker, decimals, amount)
    select ins.id, a->>'unit', a->>'ticker', (a->>'decimals')::integer, (a->>'amount')::numeric
    from ins
    join src on (src.r->>'lineNo')::integer = ins.line_no
    cross join lateral jsonb_array_elements(src.r->'amounts') a
    returning 1
  )
  select count(*) into v_inserted from ins;

  if v_inserted = 0 then
    raise exception 'Nothing new to import: every row is already here' using errcode = '23514';
  end if;
  update legacy_receipt_imports set line_count = v_inserted where id = v_import;
  return jsonb_build_object(
    'importId', v_import,
    'legacyWalletId', w.id,
    'inserted', v_inserted,
    'skipped', v_total - v_inserted,
    'created', true
  );
end $$;

revoke all on function public.import_agent_legacy_receipts(text, uuid, text, text, uuid, text, text, jsonb, boolean)
  from public, authenticated, anon;
grant execute on function public.import_agent_legacy_receipts(text, uuid, text, text, uuid, text, text, jsonb, boolean)
  to service_role;
