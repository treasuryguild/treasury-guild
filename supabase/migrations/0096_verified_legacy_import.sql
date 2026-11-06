-- Verified previous-wallet import: address + ownership signatures, tx_hash /
-- output_index on every line, pending → active imports. Existing unverified
-- history is wiped (no grandfathering into Dashboard totals).

-- 0. Wipe prior unverified history ----------------------------------------------

delete from public.legacy_payment_amounts;
delete from public.legacy_payments;
delete from public.legacy_imports;
do $$ begin
  if to_regclass('public.legacy_receipt_amounts') is not null then
    delete from public.legacy_receipt_amounts;
    delete from public.legacy_receipts;
    delete from public.legacy_receipt_imports;
  end if;
  if to_regclass('public.agent_import_payloads') is not null then
    delete from public.agent_import_payloads
      where kind in ('legacy_history', 'legacy_receipts');
  end if;
end $$;
-- Wallets without an address cannot be claimed under the new rules.
delete from public.legacy_wallets where address is null;

-- 1. Previous wallets: required address + optional script claim -----------------

alter table public.legacy_wallets
  alter column address set not null;

alter table public.legacy_wallets
  add column script_cbor text
    check (script_cbor is null or (octet_length(script_cbor) between 2 and 32768
      and script_cbor ~ '^[0-9a-f]+$')),
  add column script_hash text
    check (script_hash is null or script_hash ~ '^[0-9a-f]{56}$');

alter table public.legacy_wallets
  add constraint legacy_wallets_script_pair_check
  check (
    (script_cbor is null and script_hash is null)
    or (script_cbor is not null and script_hash is not null)
  );

-- 2. Import batches: pending signatures → active --------------------------------

alter table public.legacy_imports
  add column plan_hash text check (plan_hash is null or plan_hash ~ '^[0-9a-f]{64}$'),
  add column state text not null default 'active'
    check (state in ('pending_signatures', 'active')),
  add column staged_rows jsonb,
  add column attested_at timestamptz;

alter table public.legacy_imports
  add constraint legacy_imports_pending_staged_check
  check (
    (state = 'pending_signatures' and staged_rows is not null and plan_hash is not null)
    or (state = 'active' and (staged_rows is null))
  );

-- Active imports that already exist after wipe are none; default 'active' is for
-- the activate path that inserts rows then flips state.

do $$ begin
  if to_regclass('public.legacy_receipt_imports') is not null then
    alter table public.legacy_receipt_imports
      add column if not exists plan_hash text,
      add column if not exists state text not null default 'active',
      add column if not exists staged_rows jsonb,
      add column if not exists attested_at timestamptz;
  end if;
end $$;

-- Receipt import constraints (tables exist from 0095 in normal deploy order).
do $$ begin
  if to_regclass('public.legacy_receipt_imports') is null then
    return;
  end if;
  alter table public.legacy_receipt_imports
    drop constraint if exists legacy_receipt_imports_plan_hash_check;
  alter table public.legacy_receipt_imports
    add constraint legacy_receipt_imports_plan_hash_check
    check (plan_hash is null or plan_hash ~ '^[0-9a-f]{64}$');
  alter table public.legacy_receipt_imports
    drop constraint if exists legacy_receipt_imports_state_check;
  alter table public.legacy_receipt_imports
    add constraint legacy_receipt_imports_state_check
    check (state in ('pending_signatures', 'active'));
  alter table public.legacy_receipt_imports
    drop constraint if exists legacy_receipt_imports_pending_staged_check;
  alter table public.legacy_receipt_imports
    add constraint legacy_receipt_imports_pending_staged_check
    check (
      (state = 'pending_signatures' and staged_rows is not null and plan_hash is not null)
      or (state = 'active' and (staged_rows is null))
    );
end $$;

create table public.legacy_import_signatures (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('payments', 'receipts')),
  import_id uuid not null,
  signer_address text not null
    check (octet_length(signer_address) <= 200 and signer_address ~ '^addr(_test)?1[02-9ac-hj-np-z]+$'),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{56}$'),
  cose_key text not null check (octet_length(cose_key) between 1 and 4096),
  signature text not null check (octet_length(signature) between 1 and 8192),
  signed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (kind, import_id, key_hash)
);

-- Soft FKs: payments import vs receipt import by kind (enforced in RPCs).
create index legacy_import_signatures_import_idx
  on public.legacy_import_signatures(kind, import_id);

alter table public.legacy_import_signatures enable row level security;
revoke all on public.legacy_import_signatures from anon, authenticated, service_role;
grant select, insert, update, delete on public.legacy_import_signatures to service_role;

-- 3. Payment / receipt lines: chain identity ------------------------------------

alter table public.legacy_payments
  add column tx_hash text not null default repeat('0', 64)
    check (tx_hash ~ '^[0-9a-f]{64}$'),
  add column output_index integer not null default 0
    check (output_index >= 0);

-- Drop the temporary defaults after wipe (no rows); keep NOT NULL.
alter table public.legacy_payments alter column tx_hash drop default;
alter table public.legacy_payments alter column output_index drop default;

-- Full Shelley address only (no tail-only refs).
alter table public.legacy_payments drop constraint if exists legacy_payments_recipient_ref_check;
alter table public.legacy_payments
  add constraint legacy_payments_recipient_ref_check
  check (octet_length(recipient_ref) <= 200
    and recipient_ref ~ '^addr(_test)?1[02-9ac-hj-np-z]+$');

-- Not unique: an admin may force-import two identical attribution lines
-- (includeDuplicates). Over-claim is enforced in the planner against chain sums.
create index legacy_payments_output_dedupe_idx
  on public.legacy_payments(legacy_wallet_id, tx_hash, output_index, dedupe_key);

create index legacy_payments_output_idx
  on public.legacy_payments(legacy_wallet_id, tx_hash, output_index);

do $$ begin
  if to_regclass('public.legacy_receipts') is null then
    return;
  end if;
  alter table public.legacy_receipts
    add column if not exists tx_hash text,
    add column if not exists output_index integer;
  update public.legacy_receipts set tx_hash = repeat('0', 64) where tx_hash is null;
  update public.legacy_receipts set output_index = 0 where output_index is null;
  alter table public.legacy_receipts alter column tx_hash set not null;
  alter table public.legacy_receipts alter column output_index set not null;
  alter table public.legacy_receipts drop constraint if exists legacy_receipts_tx_hash_check;
  alter table public.legacy_receipts
    add constraint legacy_receipts_tx_hash_check check (tx_hash ~ '^[0-9a-f]{64}$');
  alter table public.legacy_receipts drop constraint if exists legacy_receipts_output_index_check;
  alter table public.legacy_receipts
    add constraint legacy_receipts_output_index_check check (output_index >= 0);
  create unique index if not exists legacy_receipts_output_dedupe_uq
    on public.legacy_receipts(legacy_wallet_id, tx_hash, output_index, dedupe_key);
  create index if not exists legacy_receipts_output_idx
    on public.legacy_receipts(legacy_wallet_id, tx_hash, output_index);
end $$;

-- 4. Stage payment import (pending_signatures) ----------------------------------

create or replace function public.stage_legacy_history(
  p_legacy_wallet_id uuid,
  p_file_name text,
  p_actor text,
  p_plan_hash text,
  p_rows jsonb,
  p_replace_import_id uuid default null
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  w public.legacy_wallets;
  v_import uuid;
  v_total integer;
begin
  select * into w from legacy_wallets where id = p_legacy_wallet_id for update;
  if not found then raise exception 'Previous wallet not found' using errcode = 'P0002'; end if;
  if w.address is null then
    raise exception 'Previous wallet needs an address' using errcode = '23514';
  end if;
  if not exists (select 1 from community_members where community_id = w.community_id
    and wallet_address = p_actor and role in ('owner', 'admin')) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;
  if p_plan_hash is null or p_plan_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid plan hash' using errcode = '23514';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Rows must be a list' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total < 1 or v_total > 20000 then
    raise exception 'An import carries 1 to 20000 rows' using errcode = '23514';
  end if;
  if exists (select 1 from legacy_imports
      where legacy_wallet_id = w.id and state = 'pending_signatures'
        and (p_replace_import_id is null or id <> p_replace_import_id)) then
    raise exception 'This wallet already has an import awaiting signatures' using errcode = '23514';
  end if;

  if p_replace_import_id is not null then
    delete from legacy_import_signatures where kind = 'payments' and import_id = p_replace_import_id;
    delete from legacy_imports where id = p_replace_import_id and legacy_wallet_id = w.id;
    if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  end if;

  insert into legacy_imports(
    community_id, legacy_wallet_id, file_name, line_count, created_by,
    plan_hash, state, staged_rows
  ) values (
    w.community_id, w.id, p_file_name, v_total, p_actor,
    p_plan_hash, 'pending_signatures', p_rows
  ) returning id into v_import;

  return jsonb_build_object(
    'importId', v_import,
    'state', 'pending_signatures',
    'planHash', p_plan_hash,
    'lineCount', v_total
  );
end $$;

revoke all on function public.stage_legacy_history(uuid, text, text, text, jsonb, uuid)
  from public, authenticated, anon;
grant execute on function public.stage_legacy_history(uuid, text, text, text, jsonb, uuid)
  to service_role;

-- 5. Activate payment import after signatures -----------------------------------

create or replace function public.activate_legacy_history(
  p_import_id uuid,
  p_actor text,
  p_skip_existing boolean default true
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  imp public.legacy_imports;
  w public.legacy_wallets;
  v_total integer;
  v_inserted integer;
  p_rows jsonb;
begin
  select * into imp from legacy_imports where id = p_import_id for update;
  if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  if imp.state <> 'pending_signatures' then
    raise exception 'Import is not awaiting signatures' using errcode = '23514';
  end if;
  select * into w from legacy_wallets where id = imp.legacy_wallet_id for update;
  if not found then raise exception 'Previous wallet not found' using errcode = 'P0002'; end if;

  -- Caller may be an admin or a base-key holder finishing the last signature;
  -- routes verify signatures before calling this.
  if not exists (select 1 from community_members where community_id = w.community_id
    and wallet_address = p_actor) then
    raise exception 'Not a community member' using errcode = '42501';
  end if;

  p_rows := imp.staged_rows;
  v_total := jsonb_array_length(p_rows);

  with src as (
    select r from jsonb_array_elements(p_rows) r
  ), ins as (
    insert into legacy_payments(
      import_id, community_id, legacy_wallet_id, workgroup_id, workgroup_ref,
      recipient_ref, task, paid_on, budget_month, line_no, dedupe_key, tx_hash, output_index
    )
    select imp.id, w.community_id, w.id, (r->>'workgroupId')::uuid, r->>'workgroupRef',
      r->>'recipientRef', r->>'task', (r->>'paidOn')::date, (r->>'budgetMonth')::date,
      (r->>'lineNo')::integer, r->>'dedupeKey', lower(r->>'txHash'), (r->>'outputIndex')::integer
    from src
    where not p_skip_existing or not exists (select 1 from legacy_payments e
      where e.legacy_wallet_id = w.id and e.dedupe_key = src.r->>'dedupeKey')
    returning id, line_no
  ), amounts as (
    insert into legacy_payment_amounts(payment_id, unit, ticker, decimals, amount)
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

  update legacy_imports
    set state = 'active',
        staged_rows = null,
        line_count = v_inserted,
        attested_at = now()
    where id = imp.id;

  return jsonb_build_object(
    'importId', imp.id,
    'inserted', v_inserted,
    'skipped', v_total - v_inserted,
    'state', 'active'
  );
end $$;

revoke all on function public.activate_legacy_history(uuid, text, boolean)
  from public, authenticated, anon;
grant execute on function public.activate_legacy_history(uuid, text, boolean)
  to service_role;

-- Keep import_legacy_history as a thin wrapper for tests that still call it:
-- stages then activates in one step (no signature check — service role only;
-- app routes must not use this without attesting first). Prefer stage+activate.
create or replace function public.import_legacy_history(
  p_legacy_wallet_id uuid,
  p_file_name text,
  p_actor text,
  p_rows jsonb,
  p_replace_import_id uuid default null,
  p_skip_existing boolean default true
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  staged jsonb;
  activated jsonb;
  plan_hash text;
begin
  -- Synthetic plan hash from row count + first dedupe (dev/SQL tests only).
  plan_hash := encode(sha256(convert_to(p_rows::text, 'UTF8')), 'hex');
  staged := stage_legacy_history(
    p_legacy_wallet_id, p_file_name, p_actor, plan_hash, p_rows, p_replace_import_id
  );
  activated := activate_legacy_history((staged->>'importId')::uuid, p_actor, p_skip_existing);
  return jsonb_build_object(
    'importId', activated->>'importId',
    'inserted', (activated->>'inserted')::integer,
    'skipped', (activated->>'skipped')::integer,
    'replaced', p_replace_import_id is not null
  );
end $$;

-- 6. Stage / activate receipts --------------------------------------------------

create or replace function public.stage_legacy_receipts(
  p_legacy_wallet_id uuid,
  p_file_name text,
  p_actor text,
  p_plan_hash text,
  p_rows jsonb,
  p_replace_import_id uuid default null
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  w public.legacy_wallets;
  v_import uuid;
  v_total integer;
begin
  select * into w from legacy_wallets where id = p_legacy_wallet_id for update;
  if not found then raise exception 'Previous wallet not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from community_members where community_id = w.community_id
    and wallet_address = p_actor and role in ('owner', 'admin')) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;
  if p_plan_hash is null or p_plan_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid plan hash' using errcode = '23514';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Rows must be a list' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total < 1 or v_total > 20000 then
    raise exception 'An import carries 1 to 20000 rows' using errcode = '23514';
  end if;
  if exists (select 1 from legacy_receipt_imports
      where legacy_wallet_id = w.id and state = 'pending_signatures'
        and (p_replace_import_id is null or id <> p_replace_import_id)) then
    raise exception 'This wallet already has a receipt import awaiting signatures' using errcode = '23514';
  end if;

  if p_replace_import_id is not null then
    delete from legacy_import_signatures where kind = 'receipts' and import_id = p_replace_import_id;
    delete from legacy_receipt_imports where id = p_replace_import_id and legacy_wallet_id = w.id;
    if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  end if;

  insert into legacy_receipt_imports(
    community_id, legacy_wallet_id, file_name, line_count, created_by,
    plan_hash, state, staged_rows
  ) values (
    w.community_id, w.id, p_file_name, v_total, p_actor,
    p_plan_hash, 'pending_signatures', p_rows
  ) returning id into v_import;

  return jsonb_build_object(
    'importId', v_import,
    'state', 'pending_signatures',
    'planHash', p_plan_hash,
    'lineCount', v_total
  );
end $$;

revoke all on function public.stage_legacy_receipts(uuid, text, text, text, jsonb, uuid)
  from public, authenticated, anon;
grant execute on function public.stage_legacy_receipts(uuid, text, text, text, jsonb, uuid)
  to service_role;

create or replace function public.activate_legacy_receipts(
  p_import_id uuid,
  p_actor text,
  p_skip_existing boolean default true
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  imp public.legacy_receipt_imports;
  w public.legacy_wallets;
  v_total integer;
  v_inserted integer;
  p_rows jsonb;
begin
  select * into imp from legacy_receipt_imports where id = p_import_id for update;
  if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  if imp.state <> 'pending_signatures' then
    raise exception 'Import is not awaiting signatures' using errcode = '23514';
  end if;
  select * into w from legacy_wallets where id = imp.legacy_wallet_id for update;
  if not found then raise exception 'Previous wallet not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from community_members where community_id = w.community_id
    and wallet_address = p_actor) then
    raise exception 'Not a community member' using errcode = '42501';
  end if;

  p_rows := imp.staged_rows;
  v_total := jsonb_array_length(p_rows);

  with src as (
    select r from jsonb_array_elements(p_rows) r
  ), ins as (
    insert into legacy_receipts(
      import_id, community_id, legacy_wallet_id, received_on,
      funding_source_id, funding_commitment_id, note, line_no, dedupe_key, tx_hash, output_index
    )
    select imp.id, w.community_id, w.id, (r->>'receivedOn')::date,
      nullif(r->>'fundingSourceId', '')::uuid, nullif(r->>'fundingCommitmentId', '')::uuid,
      nullif(r->>'note', ''), (r->>'lineNo')::integer, r->>'dedupeKey',
      lower(r->>'txHash'), (r->>'outputIndex')::integer
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

  update legacy_receipt_imports
    set state = 'active',
        staged_rows = null,
        line_count = v_inserted,
        attested_at = now()
    where id = imp.id;

  return jsonb_build_object(
    'importId', imp.id,
    'inserted', v_inserted,
    'skipped', v_total - v_inserted,
    'state', 'active'
  );
end $$;

revoke all on function public.activate_legacy_receipts(uuid, text, boolean)
  from public, authenticated, anon;
grant execute on function public.activate_legacy_receipts(uuid, text, boolean)
  to service_role;

create or replace function public.import_legacy_receipts(
  p_legacy_wallet_id uuid,
  p_file_name text,
  p_actor text,
  p_rows jsonb,
  p_replace_import_id uuid default null,
  p_skip_existing boolean default true
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  staged jsonb;
  activated jsonb;
  plan_hash text;
begin
  plan_hash := encode(sha256(convert_to(p_rows::text, 'UTF8')), 'hex');
  staged := stage_legacy_receipts(
    p_legacy_wallet_id, p_file_name, p_actor, plan_hash, p_rows, p_replace_import_id
  );
  activated := activate_legacy_receipts((staged->>'importId')::uuid, p_actor, p_skip_existing);
  return jsonb_build_object(
    'importId', activated->>'importId',
    'inserted', (activated->>'inserted')::integer,
    'skipped', (activated->>'skipped')::integer,
    'replaced', p_replace_import_id is not null
  );
end $$;

-- 7. Claimed amounts already on an output (for over-claim checks) ---------------

create or replace function public.legacy_claimed_output_amounts(
  p_legacy_wallet_id uuid
) returns jsonb
language sql security invoker set search_path = public stable as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from (
    select (p.tx_hash || ':' || p.output_index::text) as k,
      jsonb_object_agg(unit, amount::text) as v
    from (
      select p.tx_hash, p.output_index, a.unit, sum(a.amount) as amount
      from legacy_payments p
      join legacy_imports i on i.id = p.import_id and i.state = 'active'
      join legacy_payment_amounts a on a.payment_id = p.id
      where p.legacy_wallet_id = p_legacy_wallet_id
      group by p.tx_hash, p.output_index, a.unit
    ) p
    group by p.tx_hash, p.output_index
  ) s
$$;

revoke all on function public.legacy_claimed_output_amounts(uuid)
  from public, authenticated, anon;
grant execute on function public.legacy_claimed_output_amounts(uuid) to service_role;

create or replace function public.legacy_claimed_receipt_output_amounts(
  p_legacy_wallet_id uuid
) returns jsonb
language sql security invoker set search_path = public stable as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from (
    select (r.tx_hash || ':' || r.output_index::text) as k,
      jsonb_object_agg(unit, amount::text) as v
    from (
      select r.tx_hash, r.output_index, a.unit, sum(a.amount) as amount
      from legacy_receipts r
      join legacy_receipt_imports i on i.id = r.import_id and i.state = 'active'
      join legacy_receipt_amounts a on a.receipt_id = r.id
      where r.legacy_wallet_id = p_legacy_wallet_id
      group by r.tx_hash, r.output_index, a.unit
    ) r
    group by r.tx_hash, r.output_index
  ) s
$$;

revoke all on function public.legacy_claimed_receipt_output_amounts(uuid)
  from public, authenticated, anon;
grant execute on function public.legacy_claimed_receipt_output_amounts(uuid) to service_role;
