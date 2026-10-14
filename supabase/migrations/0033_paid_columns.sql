-- Paid column on app boards + Paid status on GitHub repo links.
--
-- board_columns.marks_paid: the confirm poller parks a native task here once
-- its payout is on-chain (paid_tx_hash set). At most one per board; the client
-- never drops anything into it and paid tasks are not draggable.
alter table public.board_columns
  add column marks_paid boolean not null default false;
create unique index board_columns_one_paid_uq
  on public.board_columns(workgroup_id) where marks_paid;

-- Backfill: every active native board that already has columns and no Paid
-- column gets one after its last column. active_columns
-- (guard_active_workgroup) rejects inserts on archived workgroups, hence the
-- archived_at filter; a restored workgroup keeps its old layout.
insert into public.board_columns (workgroup_id, name, position, marks_paid)
select w.id, 'Paid', max(c.position) + 1, true
from public.workgroups w
join public.board_columns c on c.workgroup_id = w.id
where w.kind = 'native' and w.archived_at is null
  and not exists (
    select 1 from public.board_columns p where p.workgroup_id = w.id and p.marks_paid
  )
group by w.id;

-- Park already-paid native tasks. guard_task_lifecycle / guard_active_workgroup
-- allow only paid -> reconciled on archived rows, so archived tasks and tasks
-- of archived workgroups are left where they are.
update public.tasks t set column_id = c.id
from public.board_columns c
join public.workgroups w on w.id = c.workgroup_id
where c.marks_paid and c.workgroup_id = t.workgroup_id
  and t.source = 'native' and t.archived_at is null and w.archived_at is null
  and t.pay_state in ('paid', 'reconciled')
  and t.column_id is distinct from c.id;

-- GitHub: the Projects v2 Status option paid issues are moved to by the
-- post-payment write-back. Case-insensitive match against the project's
-- options; '' disables the move.
alter table public.github_repos
  add column paid_status text not null default 'Paid';
