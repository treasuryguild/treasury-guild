-- Forward fix for databases that already applied 0096 before stage guards,
-- non-unique receipt output index, and agent tx_hash/address writes landed.
-- Idempotent with the corrected 0096 (create or replace / drop if exists).

-- 1. Receipts: allow includeDuplicates (same output + dedupe twice) --------------

drop index if exists public.legacy_receipts_output_dedupe_uq;
create index if not exists legacy_receipts_output_dedupe_idx
  on public.legacy_receipts(legacy_wallet_id, tx_hash, output_index, dedupe_key);
create index if not exists legacy_receipts_output_idx
  on public.legacy_receipts(legacy_wallet_id, tx_hash, output_index);

-- 2. Stage payments: amounts + community workgroup check ------------------------

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
  if exists (select 1 from jsonb_array_elements(p_rows) r
    where jsonb_typeof(r->'amounts') is distinct from 'array' or jsonb_array_length(r->'amounts') = 0) then
    raise exception 'Every row needs an amount' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
    left join workgroups g on g.id = (r->>'workgroupId')::uuid and g.community_id = w.community_id
    where g.id is null) then
    raise exception 'Workgroup is not in this community' using errcode = '23503';
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

-- 3. Stage receipts: amounts + funding source / commitment checks ---------------

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

-- 4. Agent RPCs: require address + write tx_hash/output_index; mark import active.

create or replace function public.import_agent_legacy_receipts(
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
  v_address text;
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
    v_address := nullif(btrim(coalesce(p_wallet_address, '')), '');
    if v_address is null then
      raise exception 'Previous wallet needs an address' using errcode = '23514';
    end if;
    begin
      insert into legacy_wallets(community_id, name, address, created_by)
        values (p_community_id, btrim(p_wallet_name), v_address, p_actor)
        returning * into w;
    exception when unique_violation then
      raise exception 'This community already has a previous wallet with that name' using errcode = '23505';
    end;
  end if;

  insert into legacy_receipt_imports(
    community_id, legacy_wallet_id, file_name, line_count, created_by, agent_draft_id,
    state, plan_hash, attested_at
  ) values (
    w.community_id, w.id, p_file_name, v_total, p_actor, p_draft_id,
    'active', encode(sha256(convert_to(p_rows::text, 'UTF8')), 'hex'), now()
  ) returning id into v_import;

  with src as (
    select r from jsonb_array_elements(p_rows) r
  ), ins as (
    insert into legacy_receipts(import_id, community_id, legacy_wallet_id, received_on,
      funding_source_id, funding_commitment_id, note, line_no, dedupe_key, tx_hash, output_index)
    select v_import, w.community_id, w.id, (r->>'receivedOn')::date,
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
  update legacy_receipt_imports set line_count = v_inserted where id = v_import;
  return jsonb_build_object(
    'importId', v_import,
    'legacyWalletId', w.id,
    'inserted', v_inserted,
    'skipped', v_total - v_inserted,
    'created', true
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
  v_address text;
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
    v_address := nullif(btrim(coalesce(p_wallet_address, '')), '');
    if v_address is null then
      raise exception 'Previous wallet needs an address' using errcode = '23514';
    end if;
    begin
      insert into legacy_wallets(community_id, name, address, created_by)
        values (p_community_id, btrim(p_wallet_name), v_address, p_actor)
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

  insert into legacy_imports(
    community_id, legacy_wallet_id, file_name, line_count, created_by, agent_draft_id,
    state, plan_hash, attested_at
  ) values (
    w.community_id, w.id, p_file_name, v_total, p_actor, p_draft_id,
    'active', encode(sha256(convert_to(p_rows::text, 'UTF8')), 'hex'), now()
  ) returning id into v_import;

  with src as (
    select r, coalesce(v_refs ->> (r->>'workgroupRef'), r->>'workgroupId')::uuid as wg
    from jsonb_array_elements(p_rows) r
  ), ins as (
    insert into legacy_payments(import_id, community_id, legacy_wallet_id, workgroup_id, workgroup_ref,
      recipient_ref, task, paid_on, budget_month, line_no, dedupe_key, tx_hash, output_index)
    select v_import, w.community_id, w.id, src.wg, src.r->>'workgroupRef',
      src.r->>'recipientRef', src.r->>'task', (src.r->>'paidOn')::date, (src.r->>'budgetMonth')::date,
      (src.r->>'lineNo')::integer, src.r->>'dedupeKey',
      lower(src.r->>'txHash'), (src.r->>'outputIndex')::integer
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

revoke all on function public.import_agent_legacy_receipts(text, uuid, text, text, uuid, text, text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.import_agent_legacy_receipts(text, uuid, text, text, uuid, text, text, jsonb, boolean)
  to service_role;

revoke all on function public.import_agent_legacy_history(text, uuid, text, text, uuid, text, text, jsonb, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.import_agent_legacy_history(text, uuid, text, text, uuid, text, text, jsonb, jsonb, boolean)
  to service_role;
