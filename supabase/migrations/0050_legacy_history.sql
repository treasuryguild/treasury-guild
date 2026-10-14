-- Previous-wallet history: a community that moved from a normal wallet to a
-- Guild Vault treasury carries the old wallet's payments over from a CSV it
-- generated and audited itself. Nothing here is read from the chain: the old
-- wallet's address is a label, never polled. The rows are planned in
-- TypeScript (src/lib/legacyHistory) and written only by
-- import_legacy_history; the dashboard reads them as workgroup spend paid
-- from that wallet. They are not tasks, payouts, transactions or payments.

-- 1. Tables ----------------------------------------------------------------------

create table public.legacy_wallets (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 64),
  -- Display only: never read, polled or passed to chain code.
  address text check (address is null or (octet_length(address) <= 200
    and address ~ '^addr(_test)?1[02-9ac-hj-np-z]+$')),
  created_by text not null,
  created_at timestamptz not null default now()
);
create unique index legacy_wallets_name_uq on public.legacy_wallets(community_id, lower(name));

-- One uploaded CSV. line_count is how many lines it added; lines removed
-- later leave it as it was, so the difference is what was taken out.
create table public.legacy_imports (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  legacy_wallet_id uuid not null references public.legacy_wallets(id) on delete cascade,
  file_name text not null check (octet_length(file_name) between 1 and 255),
  line_count integer not null check (line_count between 1 and 5000),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index legacy_imports_wallet_idx on public.legacy_imports(legacy_wallet_id);

-- One CSV line. workgroup_id has no ON DELETE action (not RESTRICT), so a
-- cascading community delete still removes these rows in the same statement;
-- deleting a workgroup by itself is refused by workgroup_lifecycle_status.
create table public.legacy_payments (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.legacy_imports(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  legacy_wallet_id uuid not null references public.legacy_wallets(id) on delete cascade,
  workgroup_id uuid not null references public.workgroups(id),
  -- The CSV's workgroup name, normalized: what the duplicate key uses.
  workgroup_ref text not null check (octet_length(workgroup_ref) between 1 and 64),
  -- The end of the receiver's address as the CSV gives it (or a whole address).
  recipient_ref text not null check (octet_length(recipient_ref) <= 128 and
    (recipient_ref ~ '^[02-9ac-hj-np-z]{6,}$' or recipient_ref ~ '^addr(_test)?1[02-9ac-hj-np-z]+$')),
  task text not null check (char_length(task) between 1 and 500),
  paid_on date not null,
  budget_month date not null check (extract(day from budget_month) = 1),
  line_no integer not null check (line_no > 1),
  -- sha256 of the canonical row: re-importing a file skips what is already here.
  dedupe_key text not null check (dedupe_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (import_id, line_no)
);
create index legacy_payments_budget_idx on public.legacy_payments(community_id, budget_month);
create index legacy_payments_dedupe_idx on public.legacy_payments(legacy_wallet_id, dedupe_key);
create index legacy_payments_workgroup_idx on public.legacy_payments(workgroup_id);

-- Amounts in base units, one per token. The ticker and decimals are the ones
-- resolved at import, kept so the rows display without the token registry.
create table public.legacy_payment_amounts (
  payment_id uuid not null references public.legacy_payments(id) on delete cascade,
  unit text not null check (unit = 'lovelace' or unit ~ '^[0-9a-f]{56,120}$'),
  ticker text not null check (octet_length(ticker) between 1 and 32),
  decimals integer not null check (decimals between 0 and 30),
  amount numeric not null check (amount > 0 and amount = trunc(amount)),
  check (unit <> 'lovelace' or decimals = 6),
  primary key (payment_id, unit)
);

-- Service-role routes only: address fragments and uploaded task text never
-- reach the browser client. The dashboard route checks membership.
alter table public.legacy_wallets enable row level security;
alter table public.legacy_imports enable row level security;
alter table public.legacy_payments enable row level security;
alter table public.legacy_payment_amounts enable row level security;
revoke all on public.legacy_wallets, public.legacy_imports, public.legacy_payments,
  public.legacy_payment_amounts from anon, authenticated, service_role;
grant select, insert, update, delete on public.legacy_wallets, public.legacy_imports,
  public.legacy_payments, public.legacy_payment_amounts to service_role;

-- 2. A workgroup with history cannot be deleted ---------------------------------

create or replace function public.workgroup_lifecycle_status(p_workgroup_id uuid) returns jsonb
language sql security invoker set search_path = public as $$
  select jsonb_build_object(
    'archivedAt', w.archived_at,
    'outstandingTasks', (select count(*) from tasks where workgroup_id = w.id and archived_at is null and pay_state in ('payable','queued')),
    'pendingPayouts', (select count(*) from payouts p join tasks t on t.id = p.task_id
      join transactions tx on tx.id = p.transaction_id where t.workgroup_id = w.id
      and tx.state <> 3 and (tx.state in (0,1) or p.status in ('pending','submitted'))),
    'canDelete', not exists (select 1 from tasks where workgroup_id = w.id)
      and not exists (select 1 from legacy_payments where workgroup_id = w.id)
  ) from workgroups w where w.id = p_workgroup_id
$$;

-- 3. The import ------------------------------------------------------------------

-- p_rows (built by src/lib/legacyHistory/plan.ts, never by the browser):
--   [{ lineNo, workgroupId, workgroupRef, recipientRef, task, paidOn,
--      budgetMonth, dedupeKey, amounts: [{ unit, ticker, decimals, amount }] }]
-- The lock on the wallet row serializes imports of one wallet, so two uploads
-- of the same file cannot both pass the duplicate check. With
-- p_replace_import_id the old batch is deleted first, in the same
-- transaction: a refused replace keeps it.
create function public.import_legacy_history(
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
  if v_total < 1 or v_total > 5000 then
    raise exception 'An import carries 1 to 5000 rows' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
    where jsonb_typeof(r->'amounts') is distinct from 'array' or jsonb_array_length(r->'amounts') = 0) then
    raise exception 'Every row needs an amount' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
    left join workgroups g on g.id = (r->>'workgroupId')::uuid and g.community_id = w.community_id
    where g.id is null) then
    raise exception 'Workgroup is not in this community' using errcode = '23503';
  end if;

  if p_replace_import_id is not null then
    delete from legacy_imports where id = p_replace_import_id and legacy_wallet_id = w.id;
    if not found then raise exception 'Import not found' using errcode = 'P0002'; end if;
  end if;

  insert into legacy_imports(community_id, legacy_wallet_id, file_name, line_count, created_by)
    values (w.community_id, w.id, p_file_name, v_total, p_actor)
    returning id into v_import;

  -- The NOT EXISTS reads the statement's snapshot: rows repeated inside this
  -- file are all inserted (the preview warned about them), rows already
  -- stored for this wallet are skipped.
  with src as (
    select r from jsonb_array_elements(p_rows) r
  ), ins as (
    insert into legacy_payments(import_id, community_id, legacy_wallet_id, workgroup_id, workgroup_ref,
      recipient_ref, task, paid_on, budget_month, line_no, dedupe_key)
    select v_import, w.community_id, w.id, (r->>'workgroupId')::uuid, r->>'workgroupRef',
      r->>'recipientRef', r->>'task', (r->>'paidOn')::date, (r->>'budgetMonth')::date,
      (r->>'lineNo')::integer, r->>'dedupeKey'
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
  update legacy_imports set line_count = v_inserted where id = v_import;
  return jsonb_build_object(
    'importId', v_import,
    'inserted', v_inserted,
    'skipped', v_total - v_inserted,
    'replaced', p_replace_import_id is not null
  );
end $$;

revoke all on function public.import_legacy_history(uuid, text, text, jsonb, uuid, boolean)
  from public, authenticated, anon;
grant execute on function public.import_legacy_history(uuid, text, text, jsonb, uuid, boolean)
  to service_role;
