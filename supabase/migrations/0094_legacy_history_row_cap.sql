-- A payment-history file may be larger than 5,000 lines and still under the
-- 1 MB request cap. 20,000 is the backstop on one insert; 1 MB stays the
-- bound on the upload.

do $$
declare
  c name;
begin
  select conname into c from pg_constraint
    where conrelid = 'public.legacy_imports'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%line_count%';
  if c is null then
    raise exception 'legacy_imports line_count check not found';
  end if;
  execute format('alter table public.legacy_imports drop constraint %I', c);
end $$;
alter table public.legacy_imports add constraint legacy_imports_line_count_check
  check (line_count between 1 and 20000);

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

create or replace function public.import_agent_legacy_history(
  p_draft_id text,
  p_community_id uuid,
  p_actor text,
  p_file_name text,
  p_legacy_wallet_id uuid,
  p_wallet_name text,
  p_wallet_address text,
  p_workgroups jsonb,
  p_rows jsonb,
  p_skip_existing boolean
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  w public.legacy_wallets;
  v_existing public.legacy_imports;
  v_item jsonb;
  v_ref text;
  v_display text;
  v_id uuid;
  v_refs jsonb := '{}'::jsonb;
  v_import uuid;
  v_total integer;
  v_inserted integer;
begin
  if p_draft_id !~ '^[0-9a-f]{32}$' then
    raise exception 'Draft id is not valid' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtext('treasury-guild/agent-import'), hashtext(p_draft_id));

  if not exists (select 1 from community_members where community_id = p_community_id
    and wallet_address = p_actor and role in ('owner', 'admin')) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;

  select * into v_existing from legacy_imports where agent_draft_id = p_draft_id;
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
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_typeof(p_workgroups) is distinct from 'array' then
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

  for v_item in select value from jsonb_array_elements(p_workgroups) loop
    v_ref := v_item->>'ref';
    if octet_length(coalesce(v_ref, '')) < 1 or octet_length(v_ref) > 64 then
      raise exception 'Name the workgroup' using errcode = '23514';
    end if;
    if v_item->>'action' = 'map' then
      v_id := (v_item->>'workgroupId')::uuid;
      if not exists (select 1 from workgroups where id = v_id and community_id = p_community_id) then
        raise exception 'Workgroup is not in this community' using errcode = '23503';
      end if;
    elsif v_item->>'action' = 'create' then
      if public.governance_enabled(p_community_id, 'workgroup') then
        raise exception 'New workgroups need a passed proposal while workgroup governance is on. Map the name to an existing workgroup instead.'
          using errcode = '23514';
      end if;
      v_display := btrim(coalesce(nullif(v_item->>'displayName', ''), v_ref));
      if public.workgroup_name_taken(p_community_id, v_display) then
        raise exception 'A workgroup named % already exists', v_display using errcode = '23505';
      end if;
      insert into workgroups(community_id, name, kind) values (p_community_id, v_display, 'native') returning id into v_id;
      insert into board_columns(workgroup_id, name, position, marks_payable, marks_paid) values
        (v_id, 'To Do', 0, false, false),
        (v_id, 'In Progress', 1, false, false),
        (v_id, 'Done', 2, false, false),
        (v_id, 'Audited', 3, true, false),
        (v_id, 'Paid', 4, false, true);
    else
      raise exception 'Unknown workgroup action' using errcode = '23514';
    end if;
    insert into workgroup_import_aliases(community_id, name, workgroup_id, created_by)
      values (p_community_id, v_ref, v_id, p_actor)
      on conflict (community_id, name) do update
        set workgroup_id = excluded.workgroup_id, created_by = excluded.created_by;
    v_refs := v_refs || jsonb_build_object(v_ref, v_id);
  end loop;

  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    cross join lateral (select coalesce(v_refs ->> (r->>'workgroupRef'), r->>'workgroupId') as wg) x
    where x.wg is null
      or x.wg !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not exists (select 1 from workgroups g where g.id = x.wg::uuid and g.community_id = p_community_id)
  ) then
    raise exception 'Workgroup is not in this community' using errcode = '23503';
  end if;

  insert into legacy_imports(community_id, legacy_wallet_id, file_name, line_count, created_by, agent_draft_id)
    values (w.community_id, w.id, p_file_name, v_total, p_actor, p_draft_id)
    returning id into v_import;

  with src as (
    select r, coalesce(v_refs ->> (r->>'workgroupRef'), r->>'workgroupId')::uuid as wg
    from jsonb_array_elements(p_rows) r
  ), ins as (
    insert into legacy_payments(import_id, community_id, legacy_wallet_id, workgroup_id, workgroup_ref,
      recipient_ref, task, paid_on, budget_month, line_no, dedupe_key)
    select v_import, w.community_id, w.id, src.wg, src.r->>'workgroupRef',
      src.r->>'recipientRef', src.r->>'task', (src.r->>'paidOn')::date, (src.r->>'budgetMonth')::date,
      (src.r->>'lineNo')::integer, src.r->>'dedupeKey'
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
    'legacyWalletId', w.id,
    'inserted', v_inserted,
    'skipped', v_total - v_inserted,
    'created', true
  );
end $$;
