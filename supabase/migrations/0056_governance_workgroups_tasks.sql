-- Proposals for new workgroups and for tasks proposed by members (0055 left
-- them accepted but not carried out).
--
-- A passed workgroup proposal creates a native workgroup with the board
-- columns it carries and the proposed leads who are still members. While
-- the community's workgroup kind is on, admins can no longer create one
-- directly (workgroups_insert). A passed task proposal adds a native task to
-- the first column of its app board that is neither payable nor paid, with
-- the proposed bounty; it becomes payable the usual way, when a manager moves
-- it. What a proposal created is kept in proposals.execution_result.

alter table public.proposals add column execution_result jsonb;

-- The one workgroup name check: an active workgroup of the community by that
-- name (case and surrounding spaces ignored).
create function public.workgroup_name_taken(p_community_id uuid, p_name text) returns boolean
language sql stable security invoker set search_path = public as $$
  select exists (select 1 from workgroups where community_id = p_community_id and archived_at is null
    and lower(btrim(name)) = lower(btrim(p_name)))
$$;

create function public.apply_workgroup_proposal(p public.proposals) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_spec jsonb := p.payload->'workgroup';
  v_name text := btrim(coalesce(p.payload->'workgroup'->>'name', ''));
  v_id uuid;
begin
  if v_name = '' then raise exception 'The proposal names no workgroup' using errcode = '23514'; end if;
  if public.workgroup_name_taken(p.community_id, v_name) then
    raise exception 'A workgroup named % already exists', v_name using errcode = '23505';
  end if;
  insert into workgroups(community_id, name, description, kind)
    values (p.community_id, v_name, nullif(btrim(coalesce(v_spec->>'description', '')), ''), 'native')
    returning id into v_id;
  insert into board_columns(workgroup_id, name, position, marks_payable, marks_paid)
    select v_id, c->>'name', (c->>'position')::int, coalesce((c->>'marks_payable')::boolean, false),
      coalesce((c->>'marks_paid')::boolean, false)
    from jsonb_array_elements(coalesce(p.payload->'columns', '[]')) c;
  -- A proposed lead who left the community in the meantime is skipped.
  insert into workgroup_leads(workgroup_id, wallet_address)
    select distinct v_id, l from jsonb_array_elements_text(coalesce(v_spec->'leads', '[]')) l
    where exists (select 1 from community_members where community_id = p.community_id and wallet_address = l)
    on conflict do nothing;
  return jsonb_build_object('workgroupId', v_id);
end $$;

create function public.apply_task_proposal(p public.proposals) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_spec jsonb := p.payload->'task';
  w public.workgroups;
  v_column uuid;
  v_task uuid;
begin
  select * into w from workgroups where id = (v_spec->>'workgroupId')::uuid for update;
  if not found or w.community_id <> p.community_id then
    raise exception 'The workgroup of this task no longer exists' using errcode = '23514';
  end if;
  if w.archived_at is not null then
    raise exception 'Restore the workgroup % before adding the task', w.name using errcode = '23514';
  end if;
  if w.kind <> 'native' then
    raise exception 'Tasks are proposed only on app boards, and % is a GitHub board', w.name using errcode = '23514';
  end if;
  select id into v_column from board_columns
    where workgroup_id = w.id and not marks_payable and not marks_paid order by position limit 1;
  -- number and community_id come from assign_task_number; budget_month is stamped by build-payout.
  insert into tasks(workgroup_id, source, title, body, amounts, bounty_lovelace, pay_state, audited, column_id)
    values (w.id, 'native', p.title, nullif(p.body, ''), v_spec->'amounts',
      nullif(v_spec->>'bountyLovelace', '')::bigint, 'none', false, v_column)
    returning id into v_task;
  if coalesce((v_spec->>'assignSelf')::boolean, false) and exists (select 1 from community_members
      where community_id = p.community_id and wallet_address = p.proposer) then
    insert into task_assignees(task_id, source, wallet_address, position) values (v_task, 'manual', p.proposer, 0);
  end if;
  return jsonb_build_object('taskId', v_task, 'workgroupId', w.id);
end $$;

-- As in 0055, with every kind carried out and what it created recorded.
create or replace function public.execute_proposal(p_id uuid, p_actor text default null)
returns text language plpgsql security invoker set search_path = public as $$
declare
  p public.proposals;
  v_result jsonb;
  v_error text;
  v_code text;
begin
  select * into p from proposals where id = p_id for update;
  if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
  if p.state <> 'passed' then raise exception 'Only a passed proposal is carried out' using errcode = '23514'; end if;
  if p.execution_state not in ('pending', 'failed') then return p.execution_state; end if;
  if p.execution_state = 'failed' and p_actor is null then return 'failed'; end if;
  begin
    perform set_config('treasury_guild.proposal_apply', p.id::text, true);
    if p.kind = 'budget' then
      perform public.run_budget_steps(
        (select coalesce(jsonb_agg(jsonb_build_object('workgroupId', b.workgroup_id, 'treasuryId', b.treasury_id,
          'baseRevision', b.base_revision)), '[]') from proposal_budget_owners b where b.proposal_id = p.id),
        coalesce(p.payload->'steps', '[]'), p.proposer, 'Proposal #' || p.number);
    elsif p.kind = 'workgroup' then
      v_result := public.apply_workgroup_proposal(p);
    elsif p.kind = 'task' then
      v_result := public.apply_task_proposal(p);
    else
      raise exception 'Proposals of this kind are not carried out' using errcode = '23514';
    end if;
    update proposals set execution_state = 'applied', executed_at = now(), execution_error = null,
      execution_result = v_result where id = p.id;
    insert into proposal_events(proposal_id, community_id, action, actor, detail)
      values (p.id, p.community_id, 'executed', p_actor, v_result);
  exception when others then
    get stacked diagnostics v_error = message_text, v_code = returned_sqlstate;
    update proposals set execution_state = 'failed', execution_error = left(v_error, 500) where id = p.id;
    insert into proposal_events(proposal_id, community_id, action, actor, detail)
      values (p.id, p.community_id, 'execution_failed', p_actor, jsonb_build_object('code', v_code, 'message', left(v_error, 500)));
  end;
  perform set_config('treasury_guild.proposal_apply', '', true);
  perform deactivate_proposal_budget_owners(p.id);
  return (select execution_state from proposals where id = p.id);
end $$;

-- New workgroups need a vote while the workgroup kind is on.
drop policy workgroups_insert on public.workgroups;
create policy workgroups_insert on public.workgroups for insert
  with check (public.is_admin(community_id) and not public.governance_enabled(community_id, 'workgroup'));

revoke all on function public.workgroup_name_taken(uuid, text) from public, anon, authenticated;
revoke all on function public.apply_workgroup_proposal(public.proposals) from public, anon, authenticated;
revoke all on function public.apply_task_proposal(public.proposals) from public, anon, authenticated;
grant execute on function public.workgroup_name_taken(uuid, text) to service_role;
grant execute on function public.apply_workgroup_proposal(public.proposals) to service_role;
grant execute on function public.apply_task_proposal(public.proposals) to service_role;
