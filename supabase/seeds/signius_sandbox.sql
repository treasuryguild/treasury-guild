-- Sandbox fixtures for the Signius preprod community: tasks to BUILD payout
-- transactions from, never to submit. Every run wipes the previous sandbox
-- (its tasks, assignees, board columns, and any never-submitted transaction
-- that pays them) and reseeds the same deterministic scenarios, so a tester
-- can edit, assign, build and delete freely and then start over.
--
-- Run:  npm run seed:sandbox            (scripts/seed.ps1 -> psql, LOCAL stack)
--       npm run seed:sandbox:remote     (the remote project; rare)
--   or: psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/seeds/signius_sandbox.sql
-- Requires migrations through 0033 and the Signius "Test Token" (GVTT) mint.
-- One atomic statement: any error rolls back the whole run. The reset refuses
-- to touch a sandbox that has on-chain history (a submitted or confirmed
-- transaction); real payouts belong to signius_live.sql.

-- Deterministic ids shaped like RFC 4122 v4 (version nibble 4, variant 8):
-- the API validates ids with z.uuid(), which rejects a bare md5 cast.
create or replace function pg_temp.seed_uuid(p text) returns uuid
language sql immutable as $$
  select overlay(overlay(md5(p) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid
$$;

do $seed$
declare
  -- Same namespace as the original seed so the existing [TEST] workgroups,
  -- their routing and their budgets are reused rather than duplicated.
  v_namespace constant text := 'signius-test-tasks-v1';
  -- Fixed dates keep runs repeatable. Each month adds 12 tasks.
  v_start_month constant date := date '2026-06-01';
  v_months constant integer := 4;
  v_community public.communities%rowtype;
  v_token record;
  v_field text := 'GVTT';
  -- Assignee pool: every Signius member, owner first. Scenario slots index
  -- into it modulo its size, so a one-member community still seeds.
  v_members text[];
  v_group_ids uuid[] := '{}';
  -- Ids from the first seed version (plain md5 casts, rejected by the API's
  -- uuid check). Reset removes those workgroups entirely, once.
  v_legacy_ids uuid[] := '{}';
  v_reset_ids uuid[];
  v_group_id uuid;
  v_column_id uuid;
  v_task_id uuid;
  v_month date;
  v_created timestamptz;
  v_stage integer;
  v_offset integer;
  v_project record;
  v_column record;
  v_task record;
  v_scenario record;
  v_budget record;
  v_budget_start date;
  v_revision integer;
  v_budgeted integer := 0;
  v_budget_consent boolean := false;
  v_amounts jsonb;
  v_lovelace bigint;
  v_budget_month date;
  v_hint text;
  v_idx integer;
  v_pos integer;
  v_count integer;
  v_tx_deleted integer := 0;
  v_tasks_deleted integer := 0;
  v_legacy_deleted integer := 0;
  v_inserted integer := 0;
  v_assigned integer := 0;
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

  -- Read the complete policy/name/precision from the mint, never reconstruct
  -- a token unit from the shortened policy ID displayed in the UI.
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
    raise exception 'Signius has no members to assign tasks to. Join the community with at least one wallet first.';
  end if;

  for v_project in select * from (values ('community'), ('product'), ('content')) as p(key) loop
    v_group_ids := v_group_ids || pg_temp.seed_uuid(v_namespace || ':' || v_community.id || ':' || v_project.key);
    v_legacy_ids := v_legacy_ids || md5(v_namespace || ':' || v_community.id || ':' || v_project.key)::uuid;
  end loop;
  v_reset_ids := v_group_ids || v_legacy_ids;

  -- ---- Reset ----------------------------------------------------------------
  -- Anything that reached the chain is history and must survive: refuse.
  if exists (
    select 1 from public.tasks t
    where t.workgroup_id = any(v_reset_ids)
      and (t.paid_tx_hash is not null or t.pay_state in ('paid', 'reconciled')
        or exists (
          select 1 from public.payouts p
          join public.transactions tx on tx.id = p.transaction_id
          where p.task_id = t.id and (tx.state in (1, 2) or tx.submitted_at is not null)))
  ) then
    raise exception 'Sandbox tasks have on-chain payout history. The sandbox is never meant to be submitted; leave this data in place and use signius_live.sql for real payouts.';
  end if;
  -- A never-submitted transaction that also pays non-sandbox tasks is not ours to delete.
  if exists (
    select 1 from public.transactions tx
    where exists (select 1 from public.payouts p join public.tasks t on t.id = p.task_id
                  where p.transaction_id = tx.id and t.workgroup_id = any(v_reset_ids))
      and exists (select 1 from public.payouts p join public.tasks t on t.id = p.task_id
                  where p.transaction_id = tx.id and not (t.workgroup_id = any(v_reset_ids)))
  ) then
    raise exception 'A transaction pays sandbox tasks together with other tasks. Delete it in the app before reseeding.';
  end if;
  -- Pending (0) and rejected (3) transactions that only pay sandbox tasks were
  -- never submitted; deleting them cascades to their payouts.
  delete from public.transactions tx
    where tx.state in (0, 3) and tx.submitted_at is null
      and exists (select 1 from public.payouts p join public.tasks t on t.id = p.task_id
                  where p.transaction_id = tx.id and t.workgroup_id = any(v_reset_ids));
  get diagnostics v_tx_deleted = row_count;
  -- Archived sandbox groups are restored so their rows can change again.
  update public.workgroups set archived_at = null, archived_by = null
    where id = any(v_reset_ids) and archived_at is not null;
  -- The lifecycle guards only delete archived native tasks in state none/payable
  -- with no payouts; the steps above and below put every sandbox task there.
  update public.tasks set pay_state = 'payable'
    where workgroup_id = any(v_reset_ids) and pay_state = 'queued';
  update public.tasks set archived_at = now()
    where workgroup_id = any(v_reset_ids) and archived_at is null;
  delete from public.tasks where workgroup_id = any(v_reset_ids);
  get diagnostics v_tasks_deleted = row_count;
  delete from public.board_columns where workgroup_id = any(v_reset_ids);
  -- Legacy-id workgroups are now empty and may go (budgets cascade with them).
  delete from public.workgroups where id = any(v_legacy_ids);
  get diagnostics v_legacy_deleted = row_count;

  -- ---- Reseed ---------------------------------------------------------------
  for v_project in select * from (values
    (1, 'community', '[TEST] Signius Community', 'Community onboarding, events, and member support.', true),
    (2, 'product', '[TEST] Signius Product QA', 'Wallet, board, and treasury testing.', true),
    (3, 'content', '[TEST] Signius Content', 'Guides, tutorials, and community updates.', false)
  ) as p(position, key, name, description, routed) loop
    v_group_id := pg_temp.seed_uuid(v_namespace || ':' || v_community.id || ':' || v_project.key);
    insert into public.workgroups (id, community_id, name, description, kind, treasury_id, created_at)
      values (v_group_id, v_community.id, v_project.name,
        'Sandbox test data (' || v_namespace || '). ' || v_project.description
          || case when v_project.routed then ' Routed to the GVTT treasury.'
                  else ' Payable from any community wallet (no treasury routing).' end,
        'native', case when v_project.routed then v_token.treasury_id end,
        v_start_month::timestamp at time zone 'UTC')
      on conflict (id) do update
        set name = excluded.name, description = excluded.description,
            kind = 'native', treasury_id = excluded.treasury_id;

    for v_column in select * from (values
      (0, 'To Do', false, false), (1, 'In Progress', false, false), (2, 'Done', false, false),
      (3, 'Audited', true, false), (4, 'Paid', false, true)
    ) as c(position, name, marks_payable, marks_paid) loop
      insert into public.board_columns (id, workgroup_id, name, position, marks_payable, marks_paid)
        values (pg_temp.seed_uuid(v_group_id || ':column:' || v_column.position), v_group_id,
          v_column.name, v_column.position, v_column.marks_payable, v_column.marks_paid);
    end loop;

    for v_offset in 0..(v_months - 1) loop
      v_month := (v_start_month + make_interval(months => v_offset))::date;
      for v_task in select * from (values
        ('community', 1, 'Review the member onboarding journey', 'Walk through joining Signius and record unclear steps. Deliver a checklist with screenshots.', 500),
        ('community', 2, 'Prepare a community feedback session', 'Draft an agenda and five questions about the community experience. Deliver the session plan.', 750),
        ('community', 3, 'Triage member support scenarios', 'Document five sample support requests, expected responses, and escalation steps.', 1000),
        ('community', 4, 'Compile the community feedback report', 'Summarize sample feedback into themes and propose three improvements. Deliver a short report.', 1250),
        ('product', 1, 'Test wallet connection and session recovery', 'Exercise connect, disconnect, refresh, and expired sessions with a preprod wallet. Record expected and actual results.', 500),
        ('product', 2, 'Verify task board editing and transitions', 'Check task creation, descriptions, rewards, and moves across all four columns. Deliver a reproducible QA checklist.', 750),
        ('product', 3, 'Review GVTT payout preparation', 'Check test-token amounts, recipient selection, and the payout preview. Record results before signing.', 1000),
        ('product', 4, 'Audit monthly treasury and budget views', 'Compare workgroup totals, token labels, and monthly filters. Document discrepancies with reproduction steps.', 1250),
        ('content', 1, 'Update the Signius quick-start guide', 'Draft a beginner guide covering membership, workgroups, and finding tasks. Deliver reviewed copy.', 500),
        ('content', 2, 'Create a task contribution tutorial', 'Explain picking a task, adding evidence, and requesting review. Deliver a tutorial with example screenshots.', 750),
        ('content', 3, 'Draft the community progress update', 'Prepare a sample update covering activities, QA findings, and upcoming priorities.', 1000),
        ('content', 4, 'Review the test-token FAQ', 'Explain GVTT rewards, testnet wallets, and the approval process. Deliver an edited FAQ and review checklist.', 1250)
      ) as t(project_key, position, title, body, reward)
      where project_key = v_project.key loop
        v_task_id := pg_temp.seed_uuid(v_group_id || ':task:' || v_month || ':' || v_task.position);
        -- Stage rotates by month, so every column holds 12 tasks and each
        -- (project, position) pair is payable in exactly one month.
        v_stage := (v_task.position - 1 + v_offset) % 4;
        v_column_id := pg_temp.seed_uuid(v_group_id || ':column:' || v_stage);
        v_created := (v_month + (v_task.position * 2 - 1))::timestamp at time zone 'UTC';
        v_amounts := jsonb_build_object(v_field, v_task.reward::text);
        v_lovelace := null;
        v_budget_month := null;
        v_hint := null;

        if v_stage = 3 then
          -- Payable scenarios, one per (project, position). Member slots index
          -- into v_members; the same slot on two tasks exercises aggregation
          -- into a single output. kind: default | multi | ada | unmapped.
          select * into v_scenario from (values
            ('community', 1, array[1],       'default',  true,  false, null::text,
               'One assignee with a budget month: the baseline payout.'),
            ('community', 2, array[1, 2],    'default',  false, false, null,
               'Two assignees: expect two outputs with identical amounts (2x the bounty). No budget month, so the build stamps the current month.'),
            ('community', 3, array[]::int[], 'default',  false, false, null,
               'No assignee: excluded from the default Payday selection; the build reports "no assignees".'),
            ('community', 4, array[2],       'multi',    true,  false, null,
               'ADA + GVTT in one output (2 ADA plus the GVTT reward).'),
            ('product',   1, array[1],       'default',  true,  false, null,
               'Same wallet as the Community baseline task: both rewards aggregate into one output.'),
            ('product',   2, array[1, 2, 3], 'default',  false, false, null,
               'Three assignees: three outputs with identical amounts (3x the bounty).'),
            ('product',   3, array[1],       'default',  false, false, 'seed-unlinked-tester',
               'A GitHub assignee with no linked wallet plus one linked wallet: blocked until the login links a wallet or is removed.'),
            ('product',   4, array[3],       'unmapped', false, false, null,
               'Carries an extra BONUS field with no token mapping: connect it to a wallet token on Payday or deselect the task.'),
            ('content',   1, array[3],       'ada',      true,  false, null,
               'ADA only (1.5 ADA), no token.'),
            ('content',   2, array[1],       'default',  false, true,  null,
               'Archived while payable: hidden from Payday until restored.'),
            ('content',   3, array[2],       'default',  true,  false, null,
               'Baseline payout from a workgroup with no treasury routing (payable from any community wallet).'),
            ('content',   4, array[3],       'default',  false, false, null,
               'Baseline payout without a budget month from an unrouted workgroup.')
          ) as s(project_key, position, slots, kind, set_month, archive, gh_login, hint)
          where s.project_key = v_project.key and s.position = v_task.position;
          v_hint := v_scenario.hint;
          -- Product QA is planned by quarter (see the budgets below): its tasks
          -- store the quarter's first month, as the task dialog writes it, and
          -- go on chain as "YYYY-Qn".
          if v_scenario.set_month then
            v_budget_month := case when v_project.key = 'product'
              then date_trunc('quarter', v_month)::date else v_month end;
          end if;
          if v_scenario.kind = 'multi' then
            v_amounts := jsonb_build_object('ADA', '2', v_field, v_task.reward::text);
            v_lovelace := 2000000;
          elsif v_scenario.kind = 'ada' then
            v_amounts := jsonb_build_object('ADA', '1.5');
            v_lovelace := 1500000;
          elsif v_scenario.kind = 'unmapped' then
            v_amounts := jsonb_build_object(v_field, v_task.reward::text, 'BONUS', '10');
          end if;
        end if;

        insert into public.tasks (
          id, workgroup_id, source, title, body, column_id, amounts, bounty_lovelace,
          pay_state, audited, budget_month, created_at, updated_at
        ) values (
          v_task_id, v_group_id, 'native',
          '[TEST ' || to_char(v_month, 'YYYY-MM') || '] ' || v_task.title,
          'Synthetic Signius sandbox task; the board stage is a test scenario, not evidence of completed work. '
            || 'Never submit a transaction built from sandbox tasks: the seed deletes and recreates them.' || E'\n\n'
            || 'Reporting month: ' || to_char(v_month, 'YYYY-MM') || E'\n\n' || v_task.body
            || coalesce(E'\n\n' || 'Scenario: ' || v_hint, ''),
          v_column_id, v_amounts, v_lovelace,
          case when v_stage = 3 then 'payable'::public.task_pay_state else 'none'::public.task_pay_state end,
          v_stage = 3, v_budget_month,
          v_created, v_created
        );
        v_inserted := v_inserted + 1;

        if v_stage = 3 then
          v_pos := 0;
          if v_scenario.gh_login is not null then
            insert into public.task_assignees (task_id, source, gh_login, position)
              values (v_task_id, 'github', v_scenario.gh_login, v_pos);
            v_assigned := v_assigned + 1;
            v_pos := v_pos + 1;
          end if;
          foreach v_idx in array v_scenario.slots loop
            insert into public.task_assignees (task_id, source, wallet_address, position)
              values (v_task_id, 'manual', v_members[((v_idx - 1) % cardinality(v_members)) + 1], v_pos)
              on conflict (task_id, wallet_address) where wallet_address is not null do nothing;
            get diagnostics v_count = row_count;
            v_assigned := v_assigned + v_count;
            v_pos := v_pos + v_count;
          end loop;
          if v_scenario.archive then
            update public.tasks set archived_at = v_created + interval '1 day' where id = v_task_id;
          end if;
        elsif v_stage in (1, 2) then
          -- Work in progress or done but unaudited: one assignee so boards
          -- show who holds it; To Do stays unassigned.
          insert into public.task_assignees (task_id, source, wallet_address, position)
            values (v_task_id, 'manual',
              v_members[((v_task.position + v_offset) % cardinality(v_members)) + 1], 0);
          v_assigned := v_assigned + 1;
        end if;
      end loop;
    end loop;
  end loop;

  -- ---- Budgets --------------------------------------------------------------
  -- Set up once, through the same function the app uses, so setups, plans,
  -- revisions and audit rows look real. A workgroup that already has a setup
  -- keeps it: budget edits and resets made in the app survive a reseed (and a
  -- reset is blocked while payable tasks exist anyway). One workgroup per
  -- setup mode: recurring monthly, quarterly plan, monthly plan. Amounts sit a
  -- little above the 3,500 GVTT of rewards each workgroup carries per month.
  for v_project in select * from (values ('community'), ('product'), ('content')) as p(key) loop
    v_group_id := pg_temp.seed_uuid(v_namespace || ':' || v_community.id || ':' || v_project.key);
    if v_budget_consent or exists (select 1 from public.budget_setups where workgroup_id = v_group_id) then
      continue;
    end if;
    v_revision := coalesce(
      (select revision from public.budget_setup_states where workgroup_id = v_group_id), 0);
    for v_budget in select * from (values
      ('community', 'recurring', 'monthly',   0,  4000, 5),
      ('product',   'quarterly', 'quarterly', 0, 12000, 10),
      ('product',   'quarterly', 'quarterly', 3, 13500, 10),
      ('content',   'monthly',   'monthly',   0,  3500, 5),
      ('content',   'monthly',   'monthly',   1,  4000, 5),
      ('content',   'monthly',   'monthly',   2,  4500, 5),
      ('content',   'monthly',   'monthly',   3,  5000, 5)
    ) as b(project_key, mode, cadence, month_offset, gvtt, ada)
    where b.project_key = v_project.key order by b.month_offset loop
      -- Quarterly periods start at the quarter containing the seed window.
      v_budget_start := (case when v_budget.cadence = 'quarterly'
          then date_trunc('quarter', v_start_month) else v_start_month end
        + make_interval(months => v_budget.month_offset))::date;
      v_revision := public.save_budget_setup(
        v_group_id, v_revision, v_budget.mode, v_budget.cadence, v_budget_start,
        jsonb_build_array(
          jsonb_build_object('unit', v_token.unit,
            'amount', (v_budget.gvtt::numeric * power(10::numeric, v_token.decimals::numeric))::bigint::text,
            'asset_label', v_field, 'decimals', v_token.decimals),
          jsonb_build_object('unit', 'lovelace',
            'amount', (v_budget.ada::numeric * 1000000)::bigint::text,
            'asset_label', 'ADA', 'decimals', 6)),
        v_members[1], false, 'Seeded by signius_sandbox.sql');
    end loop;
    v_budgeted := v_budgeted + 1;
  end loop;

  -- Extra, non-payable by design: move it to Audited to test an insufficient
  -- funds failure without breaking the default build of everything else.
  v_group_id := pg_temp.seed_uuid(v_namespace || ':' || v_community.id || ':product');
  v_month := (v_start_month + make_interval(months => v_months - 1))::date;
  v_task_id := pg_temp.seed_uuid(v_group_id || ':task:' || v_month || ':5');
  v_created := (v_month + 10)::timestamp at time zone 'UTC';
  insert into public.tasks (
    id, workgroup_id, source, title, body, column_id, amounts,
    pay_state, audited, created_at, updated_at
  ) values (
    v_task_id, v_group_id, 'native',
    '[TEST ' || to_char(v_month, 'YYYY-MM') || '] Oversized reward (move to Audited to test insufficient funds)',
    'Synthetic Signius sandbox task. Its GVTT reward exceeds anything the treasury holds, so a payout built with it must fail. '
      || 'It sits in Done so the default build of the other payable tasks still succeeds.' || E'\n\n'
      || 'Reporting month: ' || to_char(v_month, 'YYYY-MM') || E'\n\n'
      || 'Scenario: insufficient funds. Move this card to Audited, select it on Payday, and expect the build to be rejected.',
    pg_temp.seed_uuid(v_group_id || ':column:2'), jsonb_build_object(v_field, '999999999'),
    'none', false, v_created, v_created
  );
  insert into public.task_assignees (task_id, source, wallet_address, position)
    values (v_task_id, 'manual', v_members[1], 0);
  v_inserted := v_inserted + 1;
  v_assigned := v_assigned + 1;

  perform set_config('seed.summary', jsonb_build_object(
    'seed', 'signius_sandbox', 'deletedTransactions', v_tx_deleted, 'deletedTasks', v_tasks_deleted,
    'deletedLegacyWorkgroups', v_legacy_deleted,
    'insertedTasks', v_inserted, 'assigneeRows', v_assigned, 'members', cardinality(v_members),
    'budgetedWorkgroups', v_budgeted, 'budgetsByProposal', v_budget_consent,
    'field', v_field, 'unit', v_token.unit, 'treasury', v_token.treasury_id)::text, false);
  raise notice 'Signius sandbox: removed % tasks, % never-submitted transactions and % legacy workgroups; inserted % tasks (% assignee rows) over % members; set up budgets on % workgroups; % through %; token % (unit %).',
    v_tasks_deleted, v_tx_deleted, v_legacy_deleted, v_inserted, v_assigned, cardinality(v_members),
    v_budgeted, v_start_month, (v_start_month + make_interval(months => v_months) - interval '1 day')::date,
    v_field, v_token.unit;
end;
$seed$;

-- Summary row (the Management API returns only the last result set, so the
-- DO block hands its counters over through a session setting).
with groups as (
  select pg_temp.seed_uuid('signius-test-tasks-v1:' || c.id || ':' || k) as id
  from public.communities c, unnest(array['community', 'product', 'content']) as k
  where c.slug = 'signius'
)
select
  current_setting('seed.summary', true)::jsonb as this_run,
  jsonb_build_object(
    'workgroups', (select count(*) from public.workgroups w where w.id in (select id from groups)),
    'budgetSetups', (select count(*) from public.budget_setups s where s.workgroup_id in (select id from groups)),
    'tasks', count(t.id),
    'payable', count(*) filter (where t.pay_state = 'payable' and t.archived_at is null),
    'archived', count(*) filter (where t.archived_at is not null),
    'withAssignees', count(*) filter (where exists (select 1 from public.task_assignees a where a.task_id = t.id)),
    'months', (select jsonb_agg(distinct to_char(created_at at time zone 'UTC', 'YYYY-MM')) from public.tasks where workgroup_id in (select id from groups)),
    'pendingTransactions', (select count(*) from public.transactions tx where tx.state = 0 and exists (
      select 1 from public.payouts p join public.tasks t2 on t2.id = p.task_id
      where p.transaction_id = tx.id and t2.workgroup_id in (select id from groups)))
  ) as sandbox_now
from public.tasks t where t.workgroup_id in (select id from groups);
