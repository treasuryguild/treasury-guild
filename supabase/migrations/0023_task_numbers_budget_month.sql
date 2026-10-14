-- Payout metadata v3 references tasks by community slug + a short per-community
-- number, attributes them to a budget month, and names the workgroup. Paid
-- tasks also keep the hash of the transaction that paid them.
alter table public.tasks
  add column community_id uuid references public.communities(id) on delete cascade,
  add column number integer,
  add column budget_month date check (budget_month is null or extract(day from budget_month) = 1),
  add column paid_tx_hash text;

update public.tasks t set community_id = w.community_id
  from public.workgroups w where w.id = t.workgroup_id;

with numbered as (
  select id, row_number() over (partition by community_id order by created_at, id) as n
  from public.tasks
)
update public.tasks t set number = numbered.n from numbered where numbered.id = t.id;

alter table public.tasks
  alter column community_id set not null,
  alter column number set not null,
  add constraint tasks_community_number_uq unique (community_id, number);

-- Numbers are issued like GitHub issue numbers: sequential per community,
-- assigned by the database so neither clients nor the GitHub sync can pick
-- one. Numbering serializes on a per-community advisory lock; max()+1 leaves
-- no gaps when an insert rolls back. Backfill of paid_tx_hash for already
-- confirmed payouts keeps the task ↔ chain link complete for old history.
create function public.assign_task_number() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select community_id into new.community_id from workgroups where id = new.workgroup_id;
  if new.community_id is null then
    raise exception 'Workgroup not found' using errcode = '23503';
  end if;
  perform pg_advisory_xact_lock(hashtext('task_number:' || new.community_id::text));
  select coalesce(max(number), 0) + 1 into new.number
    from tasks where community_id = new.community_id;
  return new;
end $$;
create trigger assign_task_number before insert on public.tasks
  for each row execute function public.assign_task_number();

create function public.guard_task_identity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.number <> old.number or new.community_id <> old.community_id then
    raise exception 'Task numbers are permanent' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger guard_task_identity before update on public.tasks
  for each row execute function public.guard_task_identity();

update public.tasks t set paid_tx_hash = tx.tx_hash
  from public.payouts p join public.transactions tx on tx.id = p.transaction_id
  where p.task_id = t.id and t.paid_tx_hash is null and tx.state = 2
    and t.pay_state in ('paid', 'reconciled');
