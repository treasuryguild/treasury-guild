-- Budget configuration can be cleared without erasing the community audit trail.
alter table public.workgroup_events
  drop constraint workgroup_events_action_check,
  add constraint workgroup_events_action_check check (action in ('archive','restore','delete','budget_reset')),
  add column reason text,
  add column budget_snapshot jsonb;
grant select on public.workgroup_events to service_role;

create function public.workgroup_budget_snapshot(p_workgroup_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'state', (select to_jsonb(s) from budget_setup_states s where workgroup_id = p_workgroup_id),
    'setups', coalesce((select jsonb_agg(to_jsonb(s) order by starts_on) from budget_setups s where workgroup_id = p_workgroup_id), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(to_jsonb(p) order by p.starts_on) from budget_plans p join budget_setups s on s.id = p.setup_id where s.workgroup_id = p_workgroup_id), '[]'::jsonb),
    'legacy', coalesce((select jsonb_agg(to_jsonb(b)) from workgroup_budgets b where workgroup_id = p_workgroup_id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(to_jsonb(h) order by changed_at, id) from budget_changes h where workgroup_id = p_workgroup_id), '[]'::jsonb)
  )
$$;

create function public.budget_reset_status(p_workgroup_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'revision', coalesce((select revision from budget_setup_states where workgroup_id = w.id), 0),
    'hasBudgets', exists (select 1 from budget_setups where workgroup_id = w.id)
      or exists (select 1 from budget_changes where workgroup_id = w.id)
      or exists (select 1 from workgroup_budgets where workgroup_id = w.id),
    'blockedReason', case
      when w.archived_at is not null then 'Restore this workgroup before resetting budgets.'
      when exists (select 1 from payouts p join tasks t on t.id = p.task_id where t.workgroup_id = w.id)
        or exists (select 1 from tasks where workgroup_id = w.id and pay_state in ('paid','reconciled'))
        then 'Budget reset is unavailable because this workgroup has payment history. Correct its budgets instead.'
      when exists (select 1 from tasks where workgroup_id = w.id and pay_state in ('payable','queued'))
        then 'Resolve payable and queued tasks before resetting budgets, including archived tasks.'
      else null end
  ) from workgroups w where w.id = p_workgroup_id
$$;

create function public.reset_workgroup_budgets(
  p_workgroup_id uuid, p_expected_revision integer, p_actor text, p_confirmation text, p_reason text
) returns integer language plpgsql security invoker set search_path = public as $$
declare w public.workgroups; s jsonb; next_revision integer;
begin
  -- Budget saves, task writes, payouts, and lifecycle actions share this lock.
  select * into w from workgroups where id = p_workgroup_id for update;
  if not found then raise exception 'Workgroup not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from community_members where community_id = w.community_id
    and wallet_address = p_actor and role in ('owner','admin')) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;
  if p_confirmation is distinct from w.name then
    raise exception 'Type the workgroup name exactly to confirm budget reset' using errcode = '23514';
  end if;
  if nullif(trim(p_reason),'') is null or length(p_reason) > 500 then
    raise exception 'Provide a reason of up to 500 characters' using errcode = '23514';
  end if;
  s := public.budget_reset_status(w.id);
  if p_expected_revision is distinct from (s->>'revision')::integer then
    raise exception 'Budgets changed since you opened this page. Reload and review before resetting.' using errcode = '40001';
  end if;
  if s->>'blockedReason' is not null then
    raise exception '%', s->>'blockedReason' using errcode = '23514';
  end if;
  if not (s->>'hasBudgets')::boolean then
    raise exception 'This workgroup has no budgets to reset' using errcode = '23514';
  end if;
  insert into workgroup_events(community_id, workgroup_id, workgroup_name, action, actor, reason, budget_snapshot)
    values(w.community_id, w.id, w.name, 'budget_reset', p_actor, trim(p_reason), public.workgroup_budget_snapshot(w.id));
  delete from budget_setups where workgroup_id = w.id;
  delete from budget_changes where workgroup_id = w.id;
  delete from workgroup_budgets where workgroup_id = w.id;
  -- Retain a monotonically increasing revision: stale editors must not revive a reset.
  insert into budget_setup_states(workgroup_id, revision, legacy_conflict)
    values(w.id, 1, false)
    on conflict(workgroup_id) do update set revision = budget_setup_states.revision + 1, legacy_conflict = false
    returning revision into next_revision;
  return next_revision;
end $$;

-- Tasks must be removed through their own lifecycle rules first. Those rules
-- prevent deleting payment history; independent task audit records survive.
create or replace function public.workgroup_lifecycle_status(p_workgroup_id uuid) returns jsonb
language sql security invoker set search_path = public as $$
  select jsonb_build_object(
    'archivedAt', w.archived_at,
    'outstandingTasks', (select count(*) from tasks where workgroup_id = w.id and archived_at is null and pay_state in ('payable','queued')),
    'pendingPayouts', (select count(*) from payouts p join tasks t on t.id = p.task_id
      join transactions tx on tx.id = p.transaction_id where t.workgroup_id = w.id
      and tx.state <> 3 and (tx.state in (0,1) or p.status in ('pending','submitted'))),
    'canDelete', not exists (select 1 from tasks where workgroup_id = w.id)
  ) from workgroups w where w.id = p_workgroup_id
$$;

create or replace function public.guard_workgroup_lifecycle() returns trigger
language plpgsql security definer set search_path = public as $$
declare s jsonb;
begin
  if tg_op = 'DELETE' then
    s := public.workgroup_lifecycle_status(old.id);
    if not (s->>'canDelete')::boolean then
      raise exception 'This workgroup still has tasks or payment history. Archive it or remove eligible tasks first.' using errcode = '23514';
    end if;
    return old;
  end if;
  if old.has_activity and not new.has_activity then
    raise exception 'Workgroup activity history cannot be cleared' using errcode = '23514';
  end if;
  if old.archived_at is not null and
    (to_jsonb(new) - 'archived_at' - 'archived_by') is distinct from
    (to_jsonb(old) - 'archived_at' - 'archived_by') then
    raise exception 'Restore this workgroup before editing it' using errcode = '23514';
  end if;
  if old.archived_at is null and new.archived_at is not null then
    s := public.workgroup_lifecycle_status(old.id);
    if (s->>'outstandingTasks')::int > 0 or (s->>'pendingPayouts')::int > 0 then
      raise exception 'Resolve payable tasks and pending payouts before archiving' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create or replace function public.change_workgroup_lifecycle(
  p_workgroup_id uuid, p_action text, p_actor text, p_confirmation text default null
) returns void language plpgsql security invoker set search_path = public as $$
declare w public.workgroups; snapshot jsonb;
begin
  select * into w from workgroups where id = p_workgroup_id for update;
  if not found then raise exception 'Workgroup not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from community_members where community_id = w.community_id
    and wallet_address = p_actor and role in ('owner','admin')) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;
  if p_action = 'archive' then
    if w.archived_at is not null then return; end if;
    update workgroups set archived_at = now(), archived_by = p_actor where id = w.id;
  elsif p_action = 'restore' then
    if w.archived_at is null then return; end if;
    update workgroups set archived_at = null, archived_by = null where id = w.id;
  elsif p_action = 'delete' then
    if p_confirmation is distinct from w.name then
      raise exception 'Type the workgroup name exactly to confirm deletion' using errcode = '23514';
    end if;
    snapshot := public.workgroup_budget_snapshot(w.id);
    delete from workgroups where id = w.id;
  else raise exception 'Unknown workgroup action' using errcode = '23514';
  end if;
  insert into workgroup_events(community_id, workgroup_id, workgroup_name, action, actor, reason, budget_snapshot)
    values(w.community_id, w.id, w.name, p_action, p_actor,
      case when p_action = 'delete' then 'Workgroup deletion confirmed by admin' end, snapshot);
end $$;

revoke all on function public.workgroup_budget_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.budget_reset_status(uuid) from public, anon, authenticated;
revoke all on function public.reset_workgroup_budgets(uuid,integer,text,text,text) from public, anon, authenticated;
grant execute on function public.workgroup_budget_snapshot(uuid) to service_role;
grant execute on function public.budget_reset_status(uuid) to service_role;
grant execute on function public.reset_workgroup_budgets(uuid,integer,text,text,text) to service_role;
