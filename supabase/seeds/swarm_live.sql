-- Live payout batches for the Signius preprod community: each run adds ONE
-- small, unique batch of payable tasks to each of the two live workgroups,
-- meant to be built, signed and really submitted, so transaction history
-- accumulates and is never rewritten. The monthly workgroup's batch covers the
-- last five budget months (the current one and the four before it), the
-- quarterly workgroup's the current quarter and the one before, so the budget
-- views show a spread of history after one payout. The two start out on
-- different treasuries when Signius has a second preprod one, so a payout can
-- be pending on each. Nothing is ever deleted or reset here.
--
-- Run:  npm run seed:live               (psql, LOCAL stack)
--       supabase db query --linked -f supabase/seeds/signius_live.sql  (the remote project; rare, see seeds/README.md)
--   or: psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/seeds/signius_live.sql
-- Requires migrations through 0035, the Signius "Test Token" (GVTT) mint, and
-- each workgroup's routed treasury holding some tADA plus GVTT (fund the second
-- treasury with a transfer from the Payments page). One atomic statement.

-- Deterministic ids shaped like RFC 4122 v4 (version nibble 4, variant 8):
-- the API validates ids with z.uuid(), which rejects a bare md5 cast.
create or replace function pg_temp.seed_uuid(p text) returns uuid
language sql immutable as $$
  select overlay(overlay(md5(p) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid
$$;

do $seed$
declare
  v_namespace constant text := 'signius-live-payouts-v1';
  -- clock_timestamp(), not now(): distinct ids even for back-to-back runs in
  -- one session. The id names the batch in task bodies; titles carry the minute.
  v_now constant timestamptz := clock_timestamp();
  v_run_id constant text := to_char(v_now at time zone 'UTC', 'YYYYMMDD-HH24MISS-MS');
  v_tag constant text := '[LIVE ' || to_char(v_now at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || '] ';
  v_month constant date := date_trunc('month', v_now at time zone 'UTC')::date;
  v_wg record;
  v_step integer;
  v_fmt text;
  v_noun text;
  v_label text;
  v_current date;
  v_first date;
  v_task_month date;
  v_offset integer;
  v_community public.communities%rowtype;
  v_group public.workgroups%rowtype;
  v_token record;
  v_field text := 'GVTT';
  v_members text[];
  v_group_id uuid;
  v_task_id uuid;
  v_task record;
  v_column record;
  v_idx integer;
  v_pos integer;
  v_count integer;
  v_inserted integer;
  v_assigned integer;
  v_budgeted boolean;
  v_budget_consent boolean := false;
  v_total_inserted integer := 0;
  v_total_assigned integer := 0;
  v_groups jsonb := '{}'::jsonb;
  v_second_treasury uuid;
  v_outstanding integer;
  v_pending_tx integer;
begin
  select * into v_community from public.communities where slug = 'signius' for update;
  if not found then
    raise exception 'Signius community not found (expected slug signius). Create it before running this seed.';
  end if;
  if v_community.network <> 0 then
    raise exception 'This seed is only for the Signius testnet community.';
  end if;
  -- With budget consent on (migration 0055) budgets change only by proposal,
  -- so the seed leaves them alone. The function is absent on an older schema.
  if to_regprocedure('public.governance_enabled(uuid,text)') is not null then
    execute 'select public.governance_enabled($1, ''budget'')' into v_budget_consent using v_community.id;
  end if;

  begin
    select distinct m.policy_id || m.asset_name_hex as unit, m.decimals, m.treasury_id
      into strict v_token
    from public.mints m
    join public.transactions tx on tx.id = m.transaction_id and tx.treasury_id = m.treasury_id
    join public.treasuries tr on tr.id = m.treasury_id and tr.community_id = m.community_id
    where m.community_id = v_community.id
      and m.asset_kind = 'ft' and m.asset_name = 'Test Token' and upper(m.ticker) = 'GVTT'
      and tx.kind = 'mint' and tx.state in (1, 2) and tr.network = 0;
  exception
    when no_data_found then
      raise exception 'No submitted/confirmed GVTT Test Token mint found in Signius.';
    when too_many_rows then
      raise exception 'Multiple GVTT Test Token units, precisions, or treasuries found. Narrow the mint selector before seeding.';
  end;

  if exists (
    select 1 from public.community_assets
    where community_id = v_community.id and lower(field_name) = 'gvtt'
      and (unit <> v_token.unit or decimals <> v_token.decimals)
  ) then
    raise exception 'Signius already maps GVTT to a different token or precision. Resolve that mapping before seeding.';
  end if;
  select field_name into v_field from public.community_assets
    where community_id = v_community.id and lower(field_name) = 'gvtt'
    order by field_name limit 1;
  v_field := coalesce(v_field, 'GVTT');
  insert into public.community_assets (community_id, field_name, unit, decimals)
    values (v_community.id, v_field, v_token.unit, v_token.decimals)
    on conflict (community_id, field_name) do nothing;

  select array_agg(m.wallet_address order by
      case m.role when 'owner' then 0 when 'admin' then 1 when 'signer' then 2 else 3 end,
      m.created_at, m.wallet_address)
    into v_members
    from public.community_members m where m.community_id = v_community.id;
  if v_members is null then
    raise exception 'Signius has no members to pay. Join the community with at least one wallet first.';
  end if;

  -- The quarterly workgroup starts out on a second Signius preprod treasury
  -- (the oldest one the monthly workgroup does not pay from: the mint treasury
  -- unless it was rerouted), so two payout transactions can be pending at
  -- once: a treasury allows only one. With a single treasury it shares the
  -- mint treasury.
  select id into v_second_treasury from public.treasuries
    where community_id = v_community.id and network = 0
      and id <> coalesce((select treasury_id from public.workgroups
        where id = pg_temp.seed_uuid(v_namespace || ':' || v_community.id || ':runs')), v_token.treasury_id)
    order by created_at, id limit 1;
  v_second_treasury := coalesce(v_second_treasury, v_token.treasury_id);

  -- Two persistent workgroups collect every batch, so the boards and the
  -- budget views show the whole payout history. Each starts out routed (cache
  -- plus the dated timeline of migration 0035); rerouting one later in the app
  -- to another Signius preprod wallet, or to "any wallet", is respected.
  for v_wg in select * from (values
    ('runs', '[LIVE] Signius Payout Runs',
       'Real preprod payout batches (' || v_namespace || '). Each seed run adds one small batch meant to be built, signed and submitted. History here is never deleted.',
       'monthly', 5, v_token.treasury_id),
    ('quarterly', '[LIVE] Signius Quarterly Runs',
       'Real preprod payout batches on a quarterly budget (' || v_namespace || '). Each seed run adds one small batch meant to be built, signed and submitted. History here is never deleted.',
       'quarterly', 2, v_second_treasury)
  ) as g(key, name, description, cadence, periods, treasury_id) loop
    -- Periods per batch: the current one plus the ones before it (five months,
    -- or two quarters). A quarter is stored as its first month.
    v_step := case when v_wg.cadence = 'quarterly' then 3 else 1 end;
    v_fmt := case when v_wg.cadence = 'quarterly' then 'YYYY-"Q"Q' else 'YYYY-MM' end;
    v_noun := case when v_wg.cadence = 'quarterly' then 'quarter' else 'month' end;
    v_current := case when v_wg.cadence = 'quarterly'
      then date_trunc('quarter', v_month::timestamp)::date else v_month end;
    v_first := (v_current - make_interval(months => v_step * (v_wg.periods - 1)))::date;
    v_inserted := 0;
    v_assigned := 0;
    v_budgeted := false;

    v_group_id := pg_temp.seed_uuid(v_namespace || ':' || v_community.id || ':' || v_wg.key);
    insert into public.workgroups (id, community_id, name, description, kind, treasury_id)
      values (v_group_id, v_community.id, v_wg.name, v_wg.description, 'native', v_wg.treasury_id)
      on conflict (id) do nothing;
    get diagnostics v_count = row_count;
    if v_count = 1 then
      insert into public.workgroup_treasury_assignments (workgroup_id, treasury_id, starts_on, reason, created_by)
        values (v_group_id, v_wg.treasury_id, date '1000-01-01', 'Seeded by signius_live.sql', v_members[1])
        on conflict (workgroup_id, starts_on) do nothing;
    end if;
    select * into v_group from public.workgroups where id = v_group_id;
    if v_group.archived_at is not null then
      raise exception 'The live workgroup % is archived. Restore it in the app before adding a batch.', v_wg.name;
    end if;
    if v_group.kind <> 'native' then
      raise exception 'The live workgroup % must stay a native board. Fix its kind before adding a batch.', v_wg.name;
    end if;
    if v_group.treasury_id is not null and not exists (
      select 1 from public.treasuries
      where id = v_group.treasury_id and community_id = v_community.id and network = 0
    ) then
      raise exception 'The live workgroup % is routed to a treasury (%) outside the Signius preprod community. Fix its routing before adding a batch.', v_wg.name, v_group.treasury_id;
    end if;

    for v_column in select * from (values
      (0, 'To Do', false, false), (1, 'In Progress', false, false), (2, 'Done', false, false),
      (3, 'Audited', true, false), (4, 'Paid', false, true)
    ) as c(position, name, marks_payable, marks_paid) loop
      -- A board may already own a Paid column (migration 0033 backfilled one
      -- with its own id); a second one would violate board_columns_one_paid_uq.
      continue when v_column.marks_paid and exists (
        select 1 from public.board_columns where workgroup_id = v_group_id and marks_paid);
      insert into public.board_columns (id, workgroup_id, name, position, marks_payable, marks_paid)
        values (pg_temp.seed_uuid(v_group_id || ':column:' || v_column.position), v_group_id,
          v_column.name, v_column.position, v_column.marks_payable, v_column.marks_paid)
        on conflict (id) do nothing;
    end loop;
    if not exists (select 1 from public.board_columns
      where id = pg_temp.seed_uuid(v_group_id || ':column:3') and workgroup_id = v_group_id and marks_payable) then
      raise exception 'The Audited column of % no longer marks tasks payable. Restore it before adding a batch.', v_wg.name;
    end if;

    -- A recurring budget the first time the workgroup is set up, written
    -- through the app's own function and starting at the earliest seeded period
    -- so every batch period has a budget; edits made later survive every run.
    -- Batches keep adding to the same periods, so the budget will eventually be
    -- exceeded: raise it in the app when that happens.
    if not v_budget_consent and not exists (select 1 from public.budget_setups where workgroup_id = v_group_id) then
      perform public.save_budget_setup(
        v_group_id,
        coalesce((select revision from public.budget_setup_states where workgroup_id = v_group_id), 0),
        'recurring', v_wg.cadence, v_first,
        jsonb_build_array(
          jsonb_build_object('unit', v_token.unit,
            'amount', (25::numeric * power(10::numeric, v_token.decimals::numeric))::bigint::text,
            'asset_label', v_field, 'decimals', v_token.decimals),
          jsonb_build_object('unit', 'lovelace', 'amount', '10000000', 'asset_label', 'ADA', 'decimals', 6)),
        v_members[1], false, 'Seeded by signius_live.sql');
      v_budgeted := true;
    end if;

    -- Earlier batches still waiting to be paid would join this one on Payday.
    select count(*) into v_outstanding from public.tasks
      where workgroup_id = v_group_id and archived_at is null and pay_state in ('payable', 'queued');
    -- Counted on the wallet that will pay this batch: the routed treasury, or
    -- every Signius treasury when the workgroup is payable from any wallet.
    select count(*) into v_pending_tx from public.transactions tx
      join public.treasuries tr on tr.id = tx.treasury_id
      where tr.community_id = v_community.id and tx.state = 0
        and (v_group.treasury_id is null or tx.treasury_id = v_group.treasury_id);

    -- The same three scenarios for each of the workgroup's budget periods.
    -- Small amounts so the batch is affordable on preprod. Member slots index
    -- into v_members modulo its size. Only the current period's ADA reward has
    -- no budget month (the build stamps the period it is paid in); a past
    -- period left unset would be attributed to the current one instead.
    for v_offset in 0..(v_wg.periods - 1) loop
      v_task_month := (v_first + make_interval(months => v_step * v_offset))::date;
      v_label := to_char(v_task_month, v_fmt);
      for v_task in select * from (values
        (1, 'Token reward',
           'One assignee, GVTT only, attributed to budget ' || v_noun || ' ' || v_label || '.',
           jsonb_build_object(v_field, '1'), null::bigint, array[1], true),
        (2, 'Token and ADA reward',
           'Two assignees paid GVTT + ADA each: two outputs with identical amounts. The first wallet also aggregates with the token reward task. Budget ' || v_noun || ' ' || v_label || '.',
           jsonb_build_object(v_field, '2.5', 'ADA', '1.5'), 1500000::bigint, array[1, 2], true),
        (3, 'ADA reward',
           case when v_task_month = v_current
             then 'One assignee, ADA only, no budget ' || v_noun || ': the build stamps the ' || v_noun || ' it is paid in.'
             else 'One assignee, ADA only, attributed to budget ' || v_noun || ' ' || v_label || '.' end,
           jsonb_build_object('ADA', '0.5'), 500000::bigint, array[3], v_task_month <> v_current)
      ) as t(position, title, hint, amounts, lovelace, slots, set_month) loop
        v_task_id := pg_temp.seed_uuid(v_group_id || ':run:' || v_run_id || ':' || v_label || ':' || v_task.position);
        if exists (select 1 from public.tasks where id = v_task_id) then
          raise exception 'Batch id % already exists. Run the seed again.', v_run_id;
        end if;
        insert into public.tasks (
          id, workgroup_id, source, title, body, column_id, amounts, bounty_lovelace,
          pay_state, audited, budget_month, created_at, updated_at
        ) values (
          v_task_id, v_group_id, 'native', v_tag || v_label || ' ' || v_task.title,
          'Live Signius payout batch ' || v_run_id || '. Build, sign and submit this batch for real on preprod; '
            || 'the seed never deletes or rewrites it.' || E'\n\n' || 'Scenario: ' || v_task.hint,
          pg_temp.seed_uuid(v_group_id || ':column:3'), v_task.amounts, v_task.lovelace,
          'payable', true, case when v_task.set_month then v_task_month end, v_now, v_now
        );
        v_inserted := v_inserted + 1;
        v_pos := 0;
        foreach v_idx in array v_task.slots loop
          insert into public.task_assignees (task_id, source, wallet_address, position)
            values (v_task_id, 'manual', v_members[((v_idx - 1) % cardinality(v_members)) + 1], v_pos)
            on conflict (task_id, wallet_address) where wallet_address is not null do nothing;
          get diagnostics v_count = row_count;
          v_assigned := v_assigned + v_count;
          v_pos := v_pos + v_count;
        end loop;
      end loop;
    end loop;

    v_total_inserted := v_total_inserted + v_inserted;
    v_total_assigned := v_total_assigned + v_assigned;
    v_groups := v_groups || jsonb_build_object(v_wg.key, jsonb_build_object(
      'name', v_wg.name, 'cadence', v_wg.cadence, 'insertedTasks', v_inserted, 'assigneeRows', v_assigned,
      'earlierUnpaidTasks', v_outstanding, 'pendingTreasuryTransactions', v_pending_tx,
      'periods', v_wg.periods, 'firstPeriod', to_char(v_first, v_fmt), 'lastPeriod', to_char(v_current, v_fmt),
      'budgeted', v_budgeted, 'budgetsByProposal', v_budget_consent, 'routedTreasury', v_group.treasury_id));
    raise notice 'Signius live batch % in %: % tasks (% assignee rows) over % %s (% to %); % earlier unpaid live tasks; % pending treasury transactions; budget %.',
      v_run_id, v_wg.name, v_inserted, v_assigned, v_wg.periods, v_noun, to_char(v_first, v_fmt), to_char(v_current, v_fmt),
      v_outstanding, v_pending_tx,
      case when v_budgeted then 'set up' when v_budget_consent then 'left to proposals' else 'already in place' end;
  end loop;

  perform set_config('seed.summary', jsonb_build_object(
    'seed', 'signius_live', 'runId', v_run_id, 'insertedTasks', v_total_inserted, 'assigneeRows', v_total_assigned,
    'members', cardinality(v_members),
    'field', v_field, 'unit', v_token.unit, 'mintTreasury', v_token.treasury_id,
    'workgroups', v_groups)::text, false);
end;
$seed$;

-- Summary row (the Management API returns only the last result set).
with live as (
  select pg_temp.seed_uuid('signius-live-payouts-v1:' || c.id || ':' || k.key) as id
  from public.communities c cross join unnest(array['runs', 'quarterly']) as k(key)
  where c.slug = 'signius'
)
select
  current_setting('seed.summary', true)::jsonb as this_run,
  jsonb_build_object(
    'tasks', count(t.id),
    'byState', (select jsonb_object_agg(pay_state, n) from (
      select pay_state, count(*) n from public.tasks where workgroup_id in (select id from live) group by 1) s),
    'paidTransactions', (select count(distinct paid_tx_hash) from public.tasks
      where workgroup_id in (select id from live) and paid_tx_hash is not null),
    'budgetSetups', (select count(*) from public.budget_setups s where s.workgroup_id in (select id from live)),
    'latestBatch', max(t.created_at)
  ) as live_now
from public.tasks t where t.workgroup_id in (select id from live);
