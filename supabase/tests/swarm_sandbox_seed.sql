-- Run with psql -f against an EMPTY disposable PostgreSQL database.
-- Everything, including the schema and roles, is rolled back.
\set ON_ERROR_STOP on
begin;
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
\ir ../migrations/0001_core.sql
\ir ../migrations/0002_treasury.sql
\ir ../migrations/0003_boards.sql
\ir ../migrations/0004_github.sql
\ir ../migrations/0005_payouts.sql
\ir ../migrations/0006_reconciliation.sql
\ir ../migrations/0007_rls.sql
\ir ../migrations/0008_github_fields.sql
\ir ../migrations/0009_multi_asset.sql
\ir ../migrations/0010_workgroup_wallets.sql
\ir ../migrations/0011_roles_github.sql
\ir ../migrations/0012_visibility_membership.sql
\ir ../migrations/0013_minting.sql
\ir ../migrations/0014_budgets_incoming_details.sql
\ir ../migrations/0015_budget_asset_metadata.sql
\ir ../migrations/0016_replace_workgroup_budgets.sql
\ir ../migrations/0017_dated_budgets.sql
\ir ../migrations/0018_quarterly_budget_plans.sql
\ir ../migrations/0019_budget_setup_history.sql
\ir ../migrations/0020_workgroup_lifecycle.sql
\ir ../migrations/0021_task_lifecycle.sql
\ir ../migrations/0022_budget_reset.sql
\ir ../migrations/0023_task_numbers_budget_month.sql
\ir ../migrations/0024_task_assignees.sql
\ir ../migrations/0029_budget_current_period.sql
\ir ../migrations/0033_paid_columns.sql

-- Fixture: Signius with three members (owner first in the assignee pool), a
-- second community, a submitted GVTT mint, and pre-existing tasks that the
-- sandbox must never touch.
insert into contributors(wallet_address) values
  ('seed-admin'), ('owner-wallet'), ('admin-wallet-1'), ('admin-wallet-2'), ('outsider');
insert into communities(id, slug, name, created_by) values
  ('10000000-0000-0000-0000-000000000001', 'signius', 'Signius', 'seed-admin'),
  ('10000000-0000-0000-0000-000000000002', 'other-community', 'Other', 'seed-admin');
insert into community_members(community_id, wallet_address, role) values
  ('10000000-0000-0000-0000-000000000001', 'owner-wallet', 'owner'),
  ('10000000-0000-0000-0000-000000000001', 'admin-wallet-1', 'admin'),
  ('10000000-0000-0000-0000-000000000001', 'admin-wallet-2', 'admin'),
  ('10000000-0000-0000-0000-000000000002', 'outsider', 'owner');
insert into treasuries(id, community_id, name, network, required, address, script_cbor) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Test treasury', 0, 1, 'test-treasury', '00');
insert into transactions(id, treasury_id, kind, tx_cbor, created_by, state) values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'mint', '00', 'seed-admin', 1);
-- Nonzero precision verifies that rewards stay human-readable, not scaled twice.
insert into mints(transaction_id, community_id, treasury_id, asset_kind, policy_id,
  policy_script, policy_script_cbor, asset_name, asset_name_hex, quantity, decimals,
  ticker, recipient, metadata, created_by) values (
  '30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001', 'ft', repeat('a',56), '{}', '00',
  'Test Token', encode(convert_to('Test Token','UTF8'),'hex'), 200000000000, 6,
  'GVTT', 'test-treasury', '{}', 'seed-admin');
insert into workgroups(id, community_id, name) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Existing project'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Other project');
insert into tasks(id, workgroup_id, title) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'Existing task'),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'Other task');
create temp table untouched as
  select to_jsonb(t) as row from tasks t union all select to_jsonb(w) from workgroups w;
-- A workgroup left by the first seed version (plain md5 id) with a task the
-- tester edited and a budget: the reset must remove all of it.
insert into workgroups(id, community_id, name, description, treasury_id) values
  (md5('signius-test-tasks-v1:10000000-0000-0000-0000-000000000001:community')::uuid,
   '10000000-0000-0000-0000-000000000001', '[TEST] Signius Community', 'Synthetic test data (signius-test-tasks-v1).',
   '20000000-0000-0000-0000-000000000001');
insert into tasks(workgroup_id, title, pay_state, audited, amounts)
  values (md5('signius-test-tasks-v1:10000000-0000-0000-0000-000000000001:community')::uuid,
    '[TEST 2026-06] legacy', 'payable', true, '{"GVTT":"5"}');

\ir ../seeds/signius_sandbox.sql
create temp view sandbox_groups as
  select id from workgroups where description like 'Sandbox test data (signius-test-tasks-v1)%';
create temp view sandbox_tasks as
  select t.*, c.marks_payable, c.workgroup_id as column_workgroup_id, c.position as column_position,
    (select count(*) from task_assignees a where a.task_id = t.id) as assignee_count,
    (select count(*) from task_assignees a where a.task_id = t.id and a.wallet_address is null) as unlinked_count
  from tasks t join board_columns c on c.id = t.column_id
  where t.workgroup_id in (select id from sandbox_groups);

do $$ begin
  if (select count(*) from sandbox_groups) <> 3 or (select count(*) from workgroups) <> 5
    or (select count(*) from board_columns) <> 15
    or (select count(*) from board_columns where marks_paid and workgroup_id in (select id from sandbox_groups)) <> 3 then
    raise exception 'Wrong workgroup or column counts';
  end if;
  if (select count(*) from sandbox_tasks) <> 49 or (select count(*) from tasks) <> 51 then
    raise exception 'Wrong task counts';
  end if;
  if exists (select 1 from workgroups where id = md5('signius-test-tasks-v1:10000000-0000-0000-0000-000000000001:community')::uuid)
    or exists (select 1 from tasks where title = '[TEST 2026-06] legacy') then
    raise exception 'Legacy-id sandbox workgroup survived';
  end if;
  -- Every seeded id must pass the API's RFC 4122 check (version 4, variant 8-b).
  if exists (select id from sandbox_groups union all select id from sandbox_tasks
      union all select id from board_columns where workgroup_id in (select id from sandbox_groups)
    except select id from (select id from sandbox_groups union all select id from sandbox_tasks
      union all select id from board_columns where workgroup_id in (select id from sandbox_groups)) x
    where id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
    raise exception 'Seeded ids are not RFC 4122 v4 shaped';
  end if;
  if exists ((select row from untouched) except (select to_jsonb(t) from tasks t union all select to_jsonb(w) from workgroups w)) then
    raise exception 'Pre-existing tasks or workgroups changed';
  end if;
  if (select count(*) from workgroups where id in (select id from sandbox_groups)
      and treasury_id = '20000000-0000-0000-0000-000000000001' and archived_at is null and has_activity) <> 2
    or not exists (select 1 from workgroups where name = '[TEST] Signius Content' and treasury_id is null and has_activity) then
    raise exception 'Wrong workgroup routing';
  end if;
  if exists (select 1 from sandbox_tasks t where t.source <> 'native' or t.column_workgroup_id <> t.workgroup_id
    or t.community_id <> '10000000-0000-0000-0000-000000000001' or t.title not like '[TEST %'
    or t.audited <> t.marks_payable
    or t.pay_state <> case when t.marks_payable then 'payable'::task_pay_state else 'none'::task_pay_state end
    or t.updated_at <> t.created_at or t.paid_tx_hash is not null) then
    raise exception 'Task routing or state is inconsistent';
  end if;
  if (select count(*) from tasks where pay_state = 'payable') <> 12
    or (select count(*) from sandbox_tasks where archived_at is not null) <> 1
    or not exists (select 1 from sandbox_tasks where archived_at is not null and pay_state = 'payable' and assignee_count = 1) then
    raise exception 'Wrong payable or archived counts';
  end if;
end $$;

-- Payable scenarios: 8 single, 1 double, 1 triple, 1 unassigned, 1 unlinked GitHub login.
do $$ begin
  if (select count(*) from sandbox_tasks where pay_state = 'payable' and assignee_count = 1 and unlinked_count = 0) <> 8
    or (select count(*) from sandbox_tasks where pay_state = 'payable' and assignee_count = 2 and unlinked_count = 0) <> 1
    or (select count(*) from sandbox_tasks where pay_state = 'payable' and assignee_count = 3) <> 1
    or (select count(*) from sandbox_tasks where pay_state = 'payable' and assignee_count = 0) <> 1
    or (select count(*) from sandbox_tasks where pay_state = 'payable' and assignee_count = 2 and unlinked_count = 1) <> 1 then
    raise exception 'Wrong assignee scenario distribution';
  end if;
  if not exists (select 1 from task_assignees a join sandbox_tasks t on t.id = a.task_id
    where a.source = 'github' and a.gh_login = 'seed-unlinked-tester' and a.wallet_address is null and t.pay_state = 'payable') then
    raise exception 'Unlinked GitHub assignee scenario missing';
  end if;
  if exists (select 1 from task_assignees a join sandbox_tasks t on t.id = a.task_id
    where a.source = 'manual' and a.wallet_address not in ('owner-wallet', 'admin-wallet-1', 'admin-wallet-2')) then
    raise exception 'Assignee outside the member pool';
  end if;
  -- Three assignees = all three members; shared wallet between Community and Product baselines.
  if (select count(distinct a.wallet_address) from task_assignees a join sandbox_tasks t on t.id = a.task_id
      where t.assignee_count = 3) <> 3
    or (select count(*) from sandbox_tasks t join task_assignees a on a.task_id = t.id
      where t.pay_state = 'payable' and t.assignee_count = 1 and a.wallet_address = 'owner-wallet' and t.archived_at is null
        and t.amounts = jsonb_build_object('GVTT', t.amounts->>'GVTT')) < 2 then
    raise exception 'Aggregation scenario missing';
  end if;
  -- Work in progress / done carry one assignee, To Do none, except the oversized card in Done.
  if exists (select 1 from sandbox_tasks where column_position = 0 and assignee_count <> 0)
    or exists (select 1 from sandbox_tasks where column_position in (1, 2) and assignee_count <> 1) then
    raise exception 'Non-payable assignee pattern wrong';
  end if;
end $$;

-- Amounts: GVTT-only by default; one ADA+GVTT, one ADA-only, one unmapped BONUS field; oversized card in Done.
do $$ begin
  if (select count(*) from sandbox_tasks where amounts ? 'ADA' and amounts ? 'GVTT' and amounts->>'ADA' = '2'
      and bounty_lovelace = 2000000 and pay_state = 'payable' and budget_month is not null) <> 1
    or (select count(*) from sandbox_tasks where amounts = '{"ADA":"1.5"}'::jsonb and bounty_lovelace = 1500000
      and pay_state = 'payable' and budget_month is not null) <> 1
    or (select count(*) from sandbox_tasks where amounts ? 'BONUS' and amounts ? 'GVTT' and pay_state = 'payable'
      and assignee_count = 1) <> 1 then
    raise exception 'Multi-asset, ADA-only or unmapped scenario wrong';
  end if;
  if exists (select 1 from sandbox_tasks where not (amounts ? 'ADA') and bounty_lovelace is not null)
    or exists (select 1 from sandbox_tasks where not (amounts ? 'ADA') and not (amounts ? 'BONUS')
      and amounts <> jsonb_build_object('GVTT', amounts->>'GVTT')) then
    raise exception 'Default amounts must be GVTT only with no lovelace';
  end if;
  if (select count(*) from sandbox_tasks where title like '%Oversized reward%' and column_position = 2
      and pay_state = 'none' and not audited and amounts->>'GVTT' = '999999999' and assignee_count = 1) <> 1 then
    raise exception 'Oversized scenario wrong';
  end if;
  -- 48 rewards of 500..1250 = 42,000 GVTT, minus the 500 the ADA-only scenario replaces.
  if (select sum((amounts->>'GVTT')::numeric) from sandbox_tasks where title not like '%Oversized reward%') <> 41500 then
    raise exception 'Wrong GVTT total';
  end if;
  -- Monthly workgroups store the task's month; the quarterly one (Product QA)
  -- stores the quarter's first month, as the task dialog writes it.
  if (select count(*) from sandbox_tasks where budget_month is not null) <> 5
    or exists (select 1 from sandbox_tasks t join workgroups w on w.id = t.workgroup_id
      where t.budget_month is not null and (t.pay_state <> 'payable' or t.budget_month <> case
        when w.name = '[TEST] Signius Product QA' then date_trunc('quarter', t.created_at at time zone 'UTC')::date
        else date_trunc('month', t.created_at at time zone 'UTC')::date end)) then
    raise exception 'Budget month attribution wrong';
  end if;
  if (select count(*) from sandbox_tasks t join workgroups w on w.id = t.workgroup_id
      where w.name = '[TEST] Signius Product QA' and t.budget_month = '2026-07-01'
        and date_trunc('month', t.created_at at time zone 'UTC')::date = '2026-09-01') <> 1 then
    raise exception 'Quarterly budget month must be quarter-aligned';
  end if;
  if (select count(distinct date_trunc('month', created_at at time zone 'UTC')) from sandbox_tasks) <> 4
    or exists (select 1 from sandbox_tasks where title not like '%Oversized reward%'
      group by date_trunc('month', created_at at time zone 'UTC') having count(*) <> 12)
    or exists (select 1 from sandbox_tasks where created_at < '2026-06-01 UTC' or created_at >= '2026-10-01 UTC') then
    raise exception 'Wrong monthly distribution';
  end if;
  if not exists (select 1 from community_assets where field_name = 'GVTT' and decimals = 6
    and unit = repeat('a',56) || encode(convert_to('Test Token','UTF8'),'hex')) then
    raise exception 'Token identity or precision lost';
  end if;
  if (select count(*) from transactions) <> 1 or exists (select 1 from payouts) then
    raise exception 'Seed must not create transactions or payouts';
  end if;
end $$;

-- Budgets: each sandbox workgroup gets one setup through save_budget_setup, by the owner,
-- covering all three setup modes; Product QA is planned by quarter.
create temp view sandbox_setups as
  select s.*, w.name as workgroup_name from budget_setups s join workgroups w on w.id = s.workgroup_id
  where s.workgroup_id in (select id from sandbox_groups);
do $$ declare gvtt text := repeat('a',56) || encode(convert_to('Test Token','UTF8'),'hex'); begin
  if (select count(*) from budget_setup_states where workgroup_id in (select id from sandbox_groups)) <> 3
    or (select count(*) from sandbox_setups) <> 3
    or (select count(distinct workgroup_id) from sandbox_setups) <> 3 then
    raise exception 'Every sandbox workgroup must have exactly one budget setup';
  end if;
  if not exists (select 1 from sandbox_setups s where s.workgroup_name = '[TEST] Signius Community'
      and s.mode = 'recurring' and s.cadence = 'monthly' and s.starts_on = '2026-06-01'
      and jsonb_array_length(s.amounts) = 2
      and s.amounts @> jsonb_build_array(
        jsonb_build_object('unit', gvtt, 'amount', '4000000000', 'asset_label', 'GVTT', 'decimals', 6),
        jsonb_build_object('unit', 'lovelace', 'amount', '5000000', 'asset_label', 'ADA', 'decimals', 6))
      and not exists (select 1 from budget_plans p where p.setup_id = s.id)) then
    raise exception 'Community recurring monthly budget wrong';
  end if;
  if not exists (select 1 from sandbox_setups s where s.workgroup_name = '[TEST] Signius Product QA'
      and s.mode = 'quarterly' and s.cadence = 'quarterly' and s.starts_on = '2026-04-01' and s.amounts = '[]'::jsonb
      and (select count(*) from budget_plans p where p.setup_id = s.id) = 2
      and exists (select 1 from budget_plans p where p.setup_id = s.id and p.starts_on = '2026-04-01'
        and p.amounts @> jsonb_build_array(jsonb_build_object('unit', gvtt, 'amount', '12000000000', 'asset_label', 'GVTT', 'decimals', 6),
          jsonb_build_object('unit', 'lovelace', 'amount', '10000000', 'asset_label', 'ADA', 'decimals', 6)))
      and exists (select 1 from budget_plans p where p.setup_id = s.id and p.starts_on = '2026-07-01'
        and p.amounts @> jsonb_build_array(jsonb_build_object('unit', gvtt, 'amount', '13500000000', 'asset_label', 'GVTT', 'decimals', 6)))) then
    raise exception 'Product QA quarterly plan wrong';
  end if;
  if not exists (select 1 from sandbox_setups s where s.workgroup_name = '[TEST] Signius Content'
      and s.mode = 'monthly' and s.cadence = 'monthly' and s.starts_on = '2026-06-01' and s.amounts = '[]'::jsonb
      and (select count(*) from budget_plans p where p.setup_id = s.id) = 4
      and (select string_agg(p.starts_on::text || ':' || (select b->>'amount' from jsonb_array_elements(p.amounts) b where b->>'unit' = gvtt), ',' order by p.starts_on)
           from budget_plans p where p.setup_id = s.id)
        = '2026-06-01:3500000000,2026-07-01:4000000000,2026-08-01:4500000000,2026-09-01:5000000000') then
    raise exception 'Content monthly plan wrong';
  end if;
  if (select count(*) from budget_changes where workgroup_id in (select id from sandbox_groups)) <> 7
    or exists (select 1 from budget_changes where workgroup_id in (select id from sandbox_groups)
      and (changed_by <> 'owner-wallet' or reason <> 'Seeded by signius_sandbox.sql')) then
    raise exception 'Budget audit rows wrong';
  end if;
  if (select string_agg(w.name || '=' || st.revision, ',' order by w.name)
      from budget_setup_states st join workgroups w on w.id = st.workgroup_id where st.workgroup_id in (select id from sandbox_groups))
    <> '[TEST] Signius Community=1,[TEST] Signius Content=4,[TEST] Signius Product QA=2' then
    raise exception 'Budget revisions wrong';
  end if;
  if exists (select 1 from budget_setups where workgroup_id not in (select id from sandbox_groups)) then
    raise exception 'Budgets leaked onto other workgroups';
  end if;
end $$;

-- Snapshot (task numbers are reissued on every reset, everything else must come back identical).
create temp table first_tasks as select to_jsonb(t) - 'number' as row from tasks t where workgroup_id in (select id from sandbox_groups);
create temp table first_assignees as select a.task_id, a.source, a.gh_login, a.wallet_address, a.position
  from task_assignees a where a.task_id in (select id from sandbox_tasks);
create temp table first_columns as select * from board_columns where workgroup_id in (select id from sandbox_groups);
create temp table first_groups as select to_jsonb(w) as row from workgroups w where id in (select id from sandbox_groups);

-- A tester edits, reassigns, adds a column, builds a pending payout and leaves a rejected one behind.
update tasks set title = 'Edited by a tester', amounts = '{"GVTT":"99"}'
  where id = (select id from sandbox_tasks where pay_state = 'payable' and archived_at is null and assignee_count = 1 order by id limit 1);
insert into task_assignees(task_id, source, wallet_address, position)
  select id, 'manual', 'admin-wallet-2', 5 from tasks where title = 'Edited by a tester'
  on conflict (task_id, wallet_address) where wallet_address is not null do nothing;
insert into board_columns(workgroup_id, name, position) select id, 'Extra', 9 from sandbox_groups limit 1;
insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state) values
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'payout', '00', 'pending-hash', 'seed-admin', 0),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'payout', '00', 'rejected-hash', 'seed-admin', 3);
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount)
  select '30000000-0000-0000-0000-000000000002', t.id, a.wallet_address, 'lovelace', 1
  from sandbox_tasks t join task_assignees a on a.task_id = t.id
  where t.pay_state = 'payable' and t.archived_at is null and a.wallet_address is not null and t.unlinked_count = 0;
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount)
  select '30000000-0000-0000-0000-000000000003', t.id, 'owner-wallet', 'lovelace', 1
  from sandbox_tasks t where t.pay_state = 'none' and t.column_position = 2 order by t.id limit 1;
update tasks set pay_state = 'queued', budget_month = '2026-09-01'
  where id in (select task_id from payouts where transaction_id = '30000000-0000-0000-0000-000000000002');
do $$ begin
  if (select count(*) from tasks where pay_state = 'queued') < 5 then raise exception 'Fixture did not queue tasks'; end if;
end $$;
-- The tester also changes a budget in the app; a reseed must keep it (budgets are seeded only once).
select save_budget_setup((select id from workgroups where name = '[TEST] Signius Community'), 1,
  'recurring', 'monthly', '2026-12-01',
  '[{"unit":"lovelace","amount":"7000000","asset_label":"ADA","decimals":6}]', 'admin-wallet-1', false, 'Tester edit');
create temp table first_budgets as
  select 'setup' as kind, to_jsonb(s) as row from budget_setups s where workgroup_id in (select id from sandbox_groups)
  union all select 'plan', to_jsonb(p) from budget_plans p join budget_setups s on s.id = p.setup_id where s.workgroup_id in (select id from sandbox_groups)
  union all select 'change', to_jsonb(c) from budget_changes c where workgroup_id in (select id from sandbox_groups)
  union all select 'state', to_jsonb(st) from budget_setup_states st where workgroup_id in (select id from sandbox_groups);

\ir ../seeds/signius_sandbox.sql
do $$ begin
  if exists ((select row from first_tasks) except (select to_jsonb(t) - 'number' from tasks t where workgroup_id in (select id from sandbox_groups)))
    or exists ((select to_jsonb(t) - 'number' from tasks t where workgroup_id in (select id from sandbox_groups)) except (select row from first_tasks)) then
    raise exception 'Reset did not restore the tasks exactly';
  end if;
  if exists ((select * from first_assignees) except (select a.task_id, a.source, a.gh_login, a.wallet_address, a.position
        from task_assignees a where a.task_id in (select id from sandbox_tasks)))
    or exists ((select a.task_id, a.source, a.gh_login, a.wallet_address, a.position
        from task_assignees a where a.task_id in (select id from sandbox_tasks)) except (select * from first_assignees)) then
    raise exception 'Reset did not restore the assignees exactly';
  end if;
  if exists ((select * from first_columns) except (select * from board_columns where workgroup_id in (select id from sandbox_groups)))
    or exists ((select * from board_columns where workgroup_id in (select id from sandbox_groups)) except (select * from first_columns)) then
    raise exception 'Reset did not restore the board columns exactly';
  end if;
  if exists ((select row from first_groups) except (select to_jsonb(w) from workgroups w where id in (select id from sandbox_groups))) then
    raise exception 'Reset changed the workgroups';
  end if;
  if (select count(*) from transactions) <> 1 or exists (select 1 from payouts)
    or exists (select 1 from tasks where pay_state = 'queued') then
    raise exception 'Never-submitted transactions were not removed';
  end if;
  -- Numbering is max()+1, so the deleted numbers 2..50 are handed out again.
  if (select max(number) from tasks) <> 50 or (select count(*) from tasks) <> 51 then
    raise exception 'Task numbers or counts after reset are wrong';
  end if;
  if exists ((select row from untouched) except (select to_jsonb(t) from tasks t union all select to_jsonb(w) from workgroups w)) then
    raise exception 'Pre-existing tasks or workgroups changed on reset';
  end if;
  if exists ((select kind, row from first_budgets) except (
        select 'setup', to_jsonb(s) from budget_setups s where workgroup_id in (select id from sandbox_groups)
        union all select 'plan', to_jsonb(p) from budget_plans p join budget_setups s on s.id = p.setup_id where s.workgroup_id in (select id from sandbox_groups)
        union all select 'change', to_jsonb(c) from budget_changes c where workgroup_id in (select id from sandbox_groups)
        union all select 'state', to_jsonb(st) from budget_setup_states st where workgroup_id in (select id from sandbox_groups)))
    or (select count(*) from budget_changes where workgroup_id in (select id from sandbox_groups)) <> 8
    or (select count(*) from budget_setups) <> (select count(*) from first_budgets where kind = 'setup') then
    raise exception 'Reset must keep budgets, including the tester''s edit, without duplicating them';
  end if;
end $$;

-- Each expected rejection is isolated; unexpected success fails the test.
savepoint submitted_history;
insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state, submitted_at) values
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 'payout', '00', 'submitted-hash', 'seed-admin', 1, now());
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount)
  select '30000000-0000-0000-0000-000000000004', id, 'owner-wallet', 'lovelace', 1
  from sandbox_tasks where pay_state = 'payable' and archived_at is null order by id limit 1;
\set ON_ERROR_STOP off
\ir ../seeds/signius_sandbox.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to submitted_history;

savepoint paid_task;
update tasks set pay_state = 'paid', paid_tx_hash = 'confirmed-hash'
  where id = (select id from sandbox_tasks where pay_state = 'payable' and archived_at is null order by id limit 1);
\set ON_ERROR_STOP off
\ir ../seeds/signius_sandbox.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to paid_task;

savepoint mixed_transaction;
insert into transactions(id, treasury_id, kind, tx_cbor, tx_hash, created_by, state) values
  ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001', 'payout', '00', 'mixed-hash', 'seed-admin', 0);
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount) values
  ('30000000-0000-0000-0000-000000000005', '50000000-0000-0000-0000-000000000001', 'owner-wallet', 'lovelace', 1);
insert into payouts(transaction_id, task_id, contributor_wallet, unit, amount)
  select '30000000-0000-0000-0000-000000000005', id, 'owner-wallet', 'lovelace', 1
  from sandbox_tasks where pay_state = 'payable' and archived_at is null order by id limit 1;
\set ON_ERROR_STOP off
\ir ../seeds/signius_sandbox.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to mixed_transaction;

savepoint no_members;
delete from community_members where community_id = '10000000-0000-0000-0000-000000000001';
\set ON_ERROR_STOP off
\ir ../seeds/signius_sandbox.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to no_members;

savepoint missing_community;
update communities set slug = 'renamed-signius' where slug = 'signius';
\set ON_ERROR_STOP off
\ir ../seeds/signius_sandbox.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to missing_community;

savepoint mainnet;
update communities set network = 1 where slug = 'signius';
\set ON_ERROR_STOP off
\ir ../seeds/signius_sandbox.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to mainnet;

savepoint missing_mint;
update transactions set state = 3;
\set ON_ERROR_STOP off
\ir ../seeds/signius_sandbox.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to missing_mint;

savepoint conflicting_mapping;
update community_assets set unit = repeat('b',56);
\set ON_ERROR_STOP off
\ir ../seeds/signius_sandbox.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to conflicting_mapping;

savepoint ambiguous_mint;
insert into mints(transaction_id, community_id, treasury_id, asset_kind, policy_id,
  policy_script, policy_script_cbor, asset_name, asset_name_hex, quantity, decimals,
  ticker, recipient, metadata, created_by)
select transaction_id, community_id, treasury_id, asset_kind, repeat('b',56),
  policy_script, policy_script_cbor, asset_name, asset_name_hex, quantity, decimals,
  ticker, recipient, metadata, created_by from mints;
\set ON_ERROR_STOP off
\ir ../seeds/signius_sandbox.sql
\if :ERROR
\else
  \quit 1
\endif
\set ON_ERROR_STOP on
rollback to ambiguous_mint;

-- A one-member community still seeds: slots wrap onto the same wallet, never duplicating it on a task.
savepoint one_member;
delete from community_members where community_id = '10000000-0000-0000-0000-000000000001' and role <> 'owner';
\ir ../seeds/signius_sandbox.sql
do $$ begin
  if exists (select 1 from task_assignees a join sandbox_tasks t on t.id = a.task_id where a.wallet_address is distinct from 'owner-wallet' and a.source = 'manual')
    or exists (select 1 from sandbox_tasks where pay_state = 'payable' and assignee_count > 2)
    or (select count(*) from sandbox_tasks) <> 49 then
    raise exception 'Single-member fallback wrong';
  end if;
end $$;
rollback to one_member;

rollback;
\echo Signius sandbox seed tests passed (all changes rolled back).
