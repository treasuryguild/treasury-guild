-- Agent CSV imports (payment history and funding schedules). An assistant
-- previews a file, which is kept here for fifteen minutes so the draft token
-- stays small, and confirming writes it in one transaction. A second confirm
-- of the same draft reads the row it already made. The Treasury and Funding
-- pages keep calling import_legacy_history and save_funding_schedule.

-- 1. The file, until the preview expires or the confirm finishes ----------------

create table public.agent_import_payloads (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  -- The wallet that previewed it. The confirm accepts only that wallet.
  wallet text not null,
  kind text not null check (kind in ('legacy_history', 'funding_schedule')),
  csv text not null check (char_length(csv) between 1 and 1000000),
  mapping jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index agent_import_payloads_expires_idx on public.agent_import_payloads(expires_at);

alter table public.agent_import_payloads enable row level security;
revoke all on public.agent_import_payloads from anon, authenticated, service_role;
grant select, insert, update, delete on public.agent_import_payloads to service_role;

-- Expired previews (reconcile sweep). A confirm deletes its own row itself.
create function public.purge_agent_import_payloads(p_now timestamptz) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_count integer;
begin
  delete from agent_import_payloads where expires_at <= p_now;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function public.purge_agent_import_payloads(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_agent_import_payloads(timestamptz) to service_role;

-- 2. Draft ids, so confirming twice writes once ---------------------------------

alter table public.legacy_imports add column agent_draft_id text;
create unique index legacy_imports_agent_draft_uq on public.legacy_imports (agent_draft_id)
  where agent_draft_id is not null;

alter table public.funding_commitments add column agent_draft_id text;
create unique index funding_commitments_agent_draft_uq on public.funding_commitments (agent_draft_id)
  where agent_draft_id is not null;

-- 3. Payment history --------------------------------------------------------------

-- p_workgroups: [{ref, action: 'create'|'map', workgroupId, displayName}].
-- A create is refused while workgroup proposals are on. p_rows is the same
-- list import_legacy_history takes; a row's workgroup is the decision's ref
-- when one was given, else its workgroupId.
create function public.import_agent_legacy_history(
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
  if v_total < 1 or v_total > 5000 then
    raise exception 'An import carries 1 to 5000 rows' using errcode = '23514';
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
revoke all on function public.import_agent_legacy_history(text, uuid, text, text, uuid, text, text, jsonb, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.import_agent_legacy_history(text, uuid, text, text, uuid, text, text, jsonb, jsonb, boolean)
  to service_role;

-- 4. Funding schedule ------------------------------------------------------------

-- p_periods is the whole schedule after mapped tokens replace earlier amounts
-- of those tokens ([{startsOn: 'YYYY-MM-DD', amounts: [...]}]). An existing
-- schedule keeps its cadence. A new one creates the source when p_source_id
-- is null, then the commitment.
create function public.import_agent_funding_schedule(
  p_draft_id text,
  p_community_id uuid,
  p_actor text,
  p_source_id uuid,
  p_source_name text,
  p_source_description text,
  p_source_url text,
  p_commitment_id uuid,
  p_commitment_name text,
  p_cadence text,
  p_periods jsonb
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_existing public.funding_commitments;
  v_source uuid;
  v_commitment uuid;
  v_count integer;
begin
  if p_draft_id !~ '^[0-9a-f]{32}$' then
    raise exception 'Draft id is not valid' using errcode = '23514';
  end if;
  if p_cadence not in ('monthly', 'quarterly') then
    raise exception 'A schedule is monthly or quarterly' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtext('treasury-guild/agent-import'), hashtext(p_draft_id));

  if not exists (select 1 from community_members where community_id = p_community_id
    and wallet_address = p_actor and role in ('owner', 'admin')) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;

  select * into v_existing from funding_commitments where agent_draft_id = p_draft_id;
  if found then
    if v_existing.community_id <> p_community_id then
      raise exception 'This draft belongs to another community' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'commitmentId', v_existing.id,
      'sourceId', v_existing.source_id,
      'periods', (select count(*) from funding_commitment_periods where commitment_id = v_existing.id),
      'created', false
    );
  end if;

  if jsonb_typeof(p_periods) is distinct from 'array'
    or jsonb_array_length(p_periods) < 1 or jsonb_array_length(p_periods) > 600 then
    raise exception 'A schedule has 1 to 600 periods' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_periods) p where not public.funding_amounts_valid(p->'amounts')) then
    raise exception 'A period''s amounts are not valid' using errcode = '23514';
  end if;
  if p_cadence = 'quarterly' and exists (select 1 from jsonb_array_elements(p_periods) p
      where extract(month from (p->>'startsOn')::date) not in (1, 4, 7, 10)) then
    raise exception 'A quarterly schedule has periods starting in January, April, July or October' using errcode = '23514';
  end if;

  if p_commitment_id is not null then
    select * into v_existing from funding_commitments where id = p_commitment_id for update;
    if not found or v_existing.community_id <> p_community_id then
      raise exception 'Commitment not found' using errcode = 'P0002';
    end if;
    if v_existing.kind <> 'schedule' then
      raise exception 'Only a schedule has periods' using errcode = '23514';
    end if;
    if v_existing.cadence is distinct from p_cadence then
      raise exception 'This schedule is %, not %', v_existing.cadence, p_cadence using errcode = '23514';
    end if;
    v_commitment := v_existing.id;
    v_source := v_existing.source_id;
    update funding_commitments set agent_draft_id = p_draft_id, updated_at = now() where id = v_commitment;
  else
    if p_source_id is not null then
      select id into v_source from funding_sources where id = p_source_id and community_id = p_community_id;
      if v_source is null then raise exception 'Funding source not found' using errcode = 'P0002'; end if;
    else
      if char_length(btrim(coalesce(p_source_name, ''))) < 1 then
        raise exception 'Name the funding source' using errcode = '23514';
      end if;
      begin
        insert into funding_sources(community_id, name, description, url, created_by)
          values (
            p_community_id,
            btrim(p_source_name),
            nullif(btrim(coalesce(p_source_description, '')), ''),
            nullif(btrim(coalesce(p_source_url, '')), ''),
            p_actor
          )
          returning id into v_source;
      exception when unique_violation then
        raise exception 'This community already has a funding source with that name' using errcode = '23505';
      end;
    end if;
    if char_length(btrim(coalesce(p_commitment_name, ''))) < 1 then
      raise exception 'Name the schedule' using errcode = '23514';
    end if;
    insert into funding_commitments(
      source_id, community_id, name, kind, cadence, amounts, created_by, agent_draft_id
    ) values (
      v_source, p_community_id, btrim(p_commitment_name), 'schedule', p_cadence, '[]', p_actor, p_draft_id
    ) returning id into v_commitment;
  end if;

  delete from funding_commitment_periods where commitment_id = v_commitment;
  insert into funding_commitment_periods(commitment_id, starts_on, amounts)
    select v_commitment, (p->>'startsOn')::date, p->'amounts' from jsonb_array_elements(p_periods) p;
  get diagnostics v_count = row_count;
  return jsonb_build_object(
    'commitmentId', v_commitment,
    'sourceId', v_source,
    'periods', v_count,
    'created', true
  );
end $$;
revoke all on function public.import_agent_funding_schedule(text, uuid, text, uuid, text, text, text, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.import_agent_funding_schedule(text, uuid, text, uuid, text, text, text, uuid, text, text, jsonb)
  to service_role;
