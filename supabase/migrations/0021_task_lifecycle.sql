-- Archive hides native tasks without erasing their board or payment history.
alter table public.tasks add column archived_at timestamptz;
create index tasks_active_workgroup_idx on public.tasks(workgroup_id) where archived_at is null;

create table public.task_events (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  task_id uuid not null,
  task_title text not null,
  action text not null check (action in ('archive', 'restore', 'delete')),
  actor text not null,
  occurred_at timestamptz not null default now()
);
alter table public.task_events enable row level security;
create policy task_events_read on public.task_events for select
  using (public.is_member(community_id));
revoke all on public.task_events from anon, authenticated, service_role;
grant select on public.task_events to authenticated, service_role;

-- Archived tasks are read-only through the normal board update path.
drop policy tasks_update on public.tasks;
create policy tasks_update on public.tasks for update
  using (archived_at is null and public.can_manage_workgroup(workgroup_id))
  with check (archived_at is null and public.can_manage_workgroup(workgroup_id));
drop policy tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert
  with check (source = 'native' and archived_at is null and public.can_manage_workgroup(workgroup_id));

create function public.task_lifecycle_status(p_task_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.tasks; pending boolean; payments boolean;
begin
  select * into t from tasks where id = p_task_id;
  if not found then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if not public.can_manage_workgroup(t.workgroup_id) then
    raise exception 'Only admins and workgroup leads can manage tasks on an active board' using errcode = '42501';
  end if;
  if t.source <> 'native' then
    raise exception 'Manage this task on GitHub' using errcode = '23514';
  end if;
  select exists (select 1 from payouts p join transactions tx on tx.id = p.transaction_id
    where p.task_id = t.id and tx.state <> 3
    and (tx.state in (0,1) or p.status in ('pending','submitted'))) into pending;
  select exists (select 1 from payouts where task_id = t.id) into payments;
  return jsonb_build_object('archivedAt', t.archived_at,
    'canArchive', t.pay_state <> 'queued' and not pending,
    'canDelete', t.archived_at is not null and not payments and t.pay_state in ('none','payable'));
end $$;

-- Defense in depth for direct SQL and service-role writes. Existing active_tasks
-- locks the parent workgroup first, serializing archive with payout insertion.
create function public.guard_task_lifecycle() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.source <> 'native' or old.archived_at is null or old.pay_state not in ('none','payable')
      or exists (select 1 from payouts where task_id = old.id) then
      raise exception 'Only archived native tasks without payment history can be deleted' using errcode = '23514';
    end if;
    return old;
  end if;
  if new.archived_at is not null and new.source <> 'native' then
    raise exception 'Manage this task on GitHub' using errcode = '23514';
  end if;
  if old.archived_at is null and new.archived_at is not null then
    if old.pay_state = 'queued' or new.pay_state = 'queued' or exists (
      select 1 from payouts p join transactions tx on tx.id = p.transaction_id
      where p.task_id = old.id and tx.state <> 3
      and (tx.state in (0,1) or p.status in ('pending','submitted'))
    ) then
      raise exception 'Resolve the pending payout before archiving this task' using errcode = '23514';
    end if;
  end if;
  if old.archived_at is not null then
    -- Refund reconciliation may still finish for historical paid tasks.
    if old.pay_state = 'paid' and new.pay_state = 'reconciled' and
      (to_jsonb(old) - 'pay_state' - 'updated_at') = (to_jsonb(new) - 'pay_state' - 'updated_at') then
      return new;
    end if;
    if (to_jsonb(old) - 'archived_at' - 'updated_at') is distinct from
      (to_jsonb(new) - 'archived_at' - 'updated_at') then
      raise exception 'Restore this task before editing or paying it' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger guard_task_lifecycle before update or delete on public.tasks
  for each row execute function public.guard_task_lifecycle();

create function public.guard_archived_task_payout() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- active_payout_insert has already locked the workgroup; archive uses that
  -- same lock, so even a payout built from a stale task snapshot is rejected.
  if exists (select 1 from tasks where id = new.task_id and archived_at is not null) then
    raise exception 'Restore this task before creating a payout' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger guard_archived_task_payout before insert on public.payouts
  for each row execute function public.guard_archived_task_payout();

create function public.change_task_lifecycle(p_task_id uuid, p_action text, p_confirmation text default null)
returns void language plpgsql security definer set search_path = public as $$
declare t public.tasks; wid uuid; cid uuid;
begin
  select workgroup_id into wid from tasks where id = p_task_id;
  if not found then raise exception 'Task not found' using errcode = 'P0002'; end if;
  select community_id into cid from workgroups where id = wid for update;
  if not public.can_manage_workgroup(wid) then
    raise exception 'Only admins and workgroup leads can manage tasks on an active board' using errcode = '42501';
  end if;
  select * into t from tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if t.workgroup_id <> wid then raise exception 'Task moved. Refresh the board and try again' using errcode = '23514'; end if;
  if t.source <> 'native' then raise exception 'Manage this task on GitHub' using errcode = '23514'; end if;
  if p_action = 'archive' then
    if t.archived_at is not null then return; end if;
    update tasks set archived_at = now(), updated_at = now() where id = t.id;
  elsif p_action = 'restore' then
    if t.archived_at is null then return; end if;
    update tasks set archived_at = null, updated_at = now() where id = t.id;
  elsif p_action = 'delete' then
    if p_confirmation is distinct from t.title then
      raise exception 'Type the task title exactly to confirm deletion' using errcode = '23514';
    end if;
    delete from tasks where id = t.id;
  else raise exception 'Unknown task action' using errcode = '23514';
  end if;
  insert into task_events(community_id, task_id, task_title, action, actor)
    values(cid, t.id, t.title, p_action, public.jwt_wallet());
end $$;
revoke all on function public.task_lifecycle_status(uuid) from public, anon, authenticated;
revoke all on function public.change_task_lifecycle(uuid,text,text) from public, anon, authenticated;
grant execute on function public.task_lifecycle_status(uuid) to authenticated;
grant execute on function public.change_task_lifecycle(uuid,text,text) to authenticated;

-- Archived payable tasks are excluded from active obligations. Restoring the
-- workgroup and then the task brings back its original payable state.
create or replace function public.workgroup_lifecycle_status(p_workgroup_id uuid) returns jsonb
language sql security invoker set search_path = public as $$
  select jsonb_build_object(
    'archivedAt', w.archived_at,
    'outstandingTasks', (select count(*) from tasks where workgroup_id = w.id and archived_at is null and pay_state in ('payable','queued')),
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
