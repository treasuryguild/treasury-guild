-- Multiple assignees per task. Every assignee is paid the task's FULL amounts
-- (N assignees = N x the bounty), one tx output per distinct wallet.
-- 'github' rows mirror the issue's assignee list and are owned by the sync:
-- the wallet is filled from contributors.github_username only while null and
-- never overwritten. 'manual' rows are written only by managers through
-- /api/tasks/assignees (service role). There are no client write policies.
create table public.task_assignees (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  source text not null check (source in ('github', 'manual')),
  gh_login text,
  wallet_address text references public.contributors(wallet_address),
  position int not null default 0,
  created_at timestamptz not null default now(),
  check ((source = 'github') = (gh_login is not null))
);

-- One row per login (case-insensitive) and one row per wallet per task: a
-- wallet listed twice would be paid twice.
create unique index task_assignees_login_uq
  on public.task_assignees (task_id, lower(gh_login)) where gh_login is not null;
create unique index task_assignees_wallet_uq
  on public.task_assignees (task_id, wallet_address) where wallet_address is not null;
create index task_assignees_task_idx on public.task_assignees (task_id);
-- OAuth link backfill and sync fill look up unlinked logins.
create index task_assignees_unlinked_login_idx
  on public.task_assignees (lower(gh_login)) where gh_login is not null and wallet_address is null;

-- Backfill: a GitHub login becomes one github row carrying login + wallet;
-- a wallet without a login becomes one manual row.
insert into public.task_assignees (task_id, source, gh_login, wallet_address, position)
select id, 'github', gh_assignee_login, assignee_wallet, 0 from public.tasks
  where gh_assignee_login is not null
union all
select id, 'manual', null, assignee_wallet, 0 from public.tasks
  where gh_assignee_login is null and assignee_wallet is not null;

-- Member-read through the parent task (mirrors tasks_read); writes are
-- service-role only.
alter table public.task_assignees enable row level security;
create policy task_assignees_read on public.task_assignees for select using (exists (
  select 1 from public.tasks t
  where t.id = task_id and public.is_member(public.workgroup_community(t.workgroup_id))));
revoke insert, update, delete on public.task_assignees from anon, authenticated;

-- Defense in depth behind the route checks: no assignee edits on archived
-- tasks or workgroups. Insert/update only so cascading deletes still work.
create function public.guard_task_assignee_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare t_archived timestamptz; w_archived timestamptz;
begin
  select t.archived_at, w.archived_at into t_archived, w_archived
    from tasks t join workgroups w on w.id = t.workgroup_id where t.id = new.task_id;
  if not found then
    raise exception 'Task not found' using errcode = '23503';
  end if;
  if t_archived is not null then
    raise exception 'Restore this task before editing assignees' using errcode = '23514';
  end if;
  if w_archived is not null then
    raise exception 'Restore this workgroup before making changes' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger guard_task_assignee_write before insert or update on public.task_assignees
  for each row execute function public.guard_task_assignee_write();

-- payouts: one row per (transaction, task, wallet, unit).
alter table public.payouts drop constraint payouts_transaction_id_task_id_unit_key;
alter table public.payouts add unique (transaction_id, task_id, contributor_wallet, unit);

drop index if exists public.tasks_gh_assignee_idx;
alter table public.tasks drop column assignee_wallet, drop column gh_assignee_login;
