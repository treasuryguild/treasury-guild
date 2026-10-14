-- The GitHub sync deletes unpaid tasks whose issue left the import filter
-- (src/lib/github/sync.ts), but guard_task_lifecycle (0021) rejected every
-- delete of a non-native task, so those tasks stayed on Payday. GitHub tasks
-- cannot be archived, so their rule is: unsettled and without payout rows.
-- Native tasks keep the archive-first rule. There is no client delete policy
-- on tasks, so only the service-role sync reaches the GitHub branch.
create or replace function public.guard_task_lifecycle() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.pay_state not in ('none','payable')
      or exists (select 1 from payouts where task_id = old.id) then
      raise exception 'Tasks with payment history cannot be deleted' using errcode = '23514';
    end if;
    if old.source = 'native' and old.archived_at is null then
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
