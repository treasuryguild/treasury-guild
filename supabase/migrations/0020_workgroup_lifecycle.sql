-- Archive preserves task/payment/budget history. Only unused groups may be deleted.
alter table public.workgroups
  add column archived_at timestamptz,
  add column archived_by text,
  add column has_activity boolean not null default false;
update public.workgroups w set has_activity = true where
  exists (select 1 from public.tasks where workgroup_id = w.id) or
  exists (select 1 from public.workgroup_budgets where workgroup_id = w.id) or
  exists (select 1 from public.budget_setups where workgroup_id = w.id) or
  exists (select 1 from public.budget_changes where workgroup_id = w.id);

-- No workgroup FK: the deletion event must survive deletion of an empty group.
create table public.workgroup_events (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  workgroup_id uuid not null,
  workgroup_name text not null,
  action text not null check (action in ('archive', 'restore', 'delete')),
  actor text not null,
  occurred_at timestamptz not null default now()
);
alter table public.workgroup_events enable row level security;
create policy workgroup_events_read on public.workgroup_events for select
  using (public.is_member(community_id));
revoke all on public.workgroup_events from anon, authenticated, service_role;
grant select on public.workgroup_events to authenticated;
grant select, insert on public.workgroup_events to service_role;

drop policy workgroups_write on public.workgroups;
create policy workgroups_insert on public.workgroups for insert
  with check (public.is_admin(community_id));
create policy workgroups_update on public.workgroups for update
  using (public.is_admin(community_id) and archived_at is null)
  with check (public.is_admin(community_id) and archived_at is null);
revoke insert, update, delete on public.workgroups from authenticated, anon;
grant insert (community_id, name, description, kind, treasury_id) on public.workgroups to authenticated;
grant update (name, description, kind, treasury_id) on public.workgroups to authenticated;

create or replace function public.can_manage_workgroup(wid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workgroups where id = wid and archived_at is null)
    and (public.is_admin(public.workgroup_community(wid)) or public.is_lead(wid))
$$;

create function public.workgroup_lifecycle_status(p_workgroup_id uuid) returns jsonb
language sql security invoker set search_path = public as $$
  select jsonb_build_object(
    'archivedAt', w.archived_at,
    'outstandingTasks', (select count(*) from tasks where workgroup_id = w.id and pay_state in ('payable','queued')),
    'pendingPayouts', (select count(*) from payouts p join tasks t on t.id = p.task_id
      join transactions tx on tx.id = p.transaction_id where t.workgroup_id = w.id
      and tx.state <> 3 and (tx.state in (0,1) or p.status in ('pending','submitted'))),
    'canDelete', not w.has_activity
      and not exists (select 1 from tasks where workgroup_id = w.id)
      and not exists (select 1 from workgroup_budgets where workgroup_id = w.id)
      and not exists (select 1 from budget_setups where workgroup_id = w.id)
      and not exists (select 1 from budget_changes where workgroup_id = w.id)
  ) from workgroups w where w.id = p_workgroup_id
$$;

-- Guards apply even to service-role callers. Child writes take the same row
-- lock as archive/delete, closing the check-then-write race with sync/payouts.
create function public.guard_workgroup_lifecycle() returns trigger
language plpgsql security definer set search_path = public as $$
declare s jsonb;
begin
  if tg_op = 'DELETE' then
    s := public.workgroup_lifecycle_status(old.id);
    if not (s->>'canDelete')::boolean then
      raise exception 'This workgroup has activity or budget history. Archive it instead.' using errcode = '23514';
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
create trigger guard_workgroup_lifecycle before update or delete on public.workgroups
  for each row execute function public.guard_workgroup_lifecycle();

create function public.guard_active_workgroup() returns trigger
language plpgsql security definer set search_path = public as $$
declare ids uuid[]; wid uuid; archived timestamptz; row_data jsonb;
begin
  -- GitHub uninstall removes connection records, even for archived groups.
  -- Stored task/payment history does not depend on these installation rows.
  if tg_op = 'DELETE' and tg_table_name in ('github_repos','github_project_links') and
    not exists (select 1 from github_installations where installation_id = (to_jsonb(old)->>'installation_id')::bigint) then
    return old;
  end if;
  -- Updates validate both sides so moving a record cannot erase archived history.
  foreach row_data in array case when tg_op = 'INSERT' then array[to_jsonb(new)]
    when tg_op = 'DELETE' then array[to_jsonb(old)] else array[to_jsonb(old), to_jsonb(new)] end loop
    if tg_table_name = 'budget_plans' then
      select workgroup_id into wid from budget_setups where id = (row_data->>'setup_id')::uuid;
    elsif tg_table_name = 'payouts' then
      select workgroup_id into wid from tasks where id = (row_data->>'task_id')::uuid;
    else wid := (row_data->>'workgroup_id')::uuid;
    end if;
    ids := array_append(ids, wid);
  end loop;
  for wid in select distinct x from unnest(ids) x where x is not null order by x loop
    select archived_at into archived from workgroups where id = wid for update;
    if archived is not null then
      -- Financial reconciliation can finish after archival; board data stays frozen.
      if tg_table_name = 'tasks' and tg_op = 'UPDATE' and
        to_jsonb(old)->>'pay_state' = 'paid' and to_jsonb(new)->>'pay_state' = 'reconciled' and
        (to_jsonb(old) - 'pay_state' - 'updated_at') = (to_jsonb(new) - 'pay_state' - 'updated_at') then
        return new;
      end if;
      raise exception 'Restore this workgroup before making changes' using errcode = '23514';
    end if;
    if tg_op <> 'DELETE' and tg_table_name in ('tasks','budget_setups','budget_changes') then
      update workgroups set has_activity = true where id = wid and not has_activity;
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger active_tasks before insert or update or delete on public.tasks
  for each row execute function public.guard_active_workgroup();
create trigger active_columns before insert or update or delete on public.board_columns
  for each row execute function public.guard_active_workgroup();
create trigger active_leads before insert or update or delete on public.workgroup_leads
  for each row execute function public.guard_active_workgroup();
create trigger active_budget_states before insert or update or delete on public.budget_setup_states
  for each row execute function public.guard_active_workgroup();
create trigger active_budget_setups before insert or update or delete on public.budget_setups
  for each row execute function public.guard_active_workgroup();
create trigger active_budget_plans before insert or update or delete on public.budget_plans
  for each row execute function public.guard_active_workgroup();
create trigger active_budget_changes before insert or update or delete on public.budget_changes
  for each row execute function public.guard_active_workgroup();
create trigger active_legacy_budget_delete before delete on public.workgroup_budgets
  for each row execute function public.guard_active_workgroup();
create trigger active_github_repos before insert or update or delete on public.github_repos
  for each row execute function public.guard_active_workgroup();
create trigger active_github_projects before insert or update or delete on public.github_project_links
  for each row execute function public.guard_active_workgroup();
create trigger active_payout_insert before insert on public.payouts
  for each row execute function public.guard_active_workgroup();

create function public.change_workgroup_lifecycle(
  p_workgroup_id uuid, p_action text, p_actor text, p_confirmation text default null
) returns void language plpgsql security invoker set search_path = public as $$
declare w public.workgroups;
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
    delete from workgroups where id = w.id;
  else raise exception 'Unknown workgroup action' using errcode = '23514';
  end if;
  insert into workgroup_events(community_id, workgroup_id, workgroup_name, action, actor)
    values(w.community_id, w.id, w.name, p_action, p_actor);
end $$;
revoke all on function public.workgroup_lifecycle_status(uuid) from public, authenticated, anon;
revoke all on function public.change_workgroup_lifecycle(uuid,text,text,text) from public, authenticated, anon;
grant execute on function public.workgroup_lifecycle_status(uuid) to service_role;
grant execute on function public.change_workgroup_lifecycle(uuid,text,text,text) to service_role;
