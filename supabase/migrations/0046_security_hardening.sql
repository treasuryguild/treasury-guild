-- Security hardening: what the browser may write on tasks, a request rate
-- limiter for the API routes, and grants that earlier migrations left open.

-- 1. Task writes from the browser --------------------------------------------------

-- tasks_insert / tasks_update (0021, 0045) check who may write a task but not
-- which columns: with the default table grants a lead could PATCH
-- /rest/v1/tasks and put a paid task back to payable (a second payout), or
-- rewrite paid_tx_hash, source or workgroup_id. The browser writes only the
-- board and task-editor fields (useBoardMutations, useTaskSave), so those are
-- the only columns it gets. Service-role routes and RPCs are unaffected.
revoke insert, update on public.tasks from anon, authenticated;
grant insert (workgroup_id, title, column_id) on public.tasks to authenticated;
grant update (title, body, column_id, audited, pay_state, budget_month, amounts, bounty_lovelace)
  on public.tasks to authenticated;

-- pay_state is still browser-writable because the native board's payable
-- column drives it. The browser may only move a native task between 'none'
-- and 'payable'; queued / paid / reconciled belong to build-payout, the
-- confirm poller and reconciliation. A task inside a payout also keeps the
-- amounts and period it was paid with (the task editor already refuses to
-- save one: the assignee route rejects settled tasks first).
create function public.guard_task_client_write() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Only a browser session is held to this; service-role calls and direct
  -- database sessions (migrations, seeds) carry no 'authenticated' role.
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if new.pay_state is distinct from old.pay_state and not (
    old.source = 'native'
    and old.pay_state in ('none', 'payable')
    and new.pay_state in ('none', 'payable')
  ) then
    raise exception 'The payment state of this task is set by its payout' using errcode = '42501';
  end if;
  if old.pay_state in ('queued', 'paid', 'reconciled') and (
    new.amounts is distinct from old.amounts
    or new.bounty_lovelace is distinct from old.bounty_lovelace
    or new.budget_month is distinct from old.budget_month
  ) then
    raise exception 'A task in a payout keeps its amounts and budget period' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger guard_task_client_write before update on public.tasks
  for each row execute function public.guard_task_client_write();
revoke all on function public.guard_task_client_write() from public, anon, authenticated;

-- 2. Rate limits ---------------------------------------------------------------------

-- Fixed-window request counters for the public and abuse-prone API routes
-- (src/lib/db/rateLimit.ts). `key` is "<bucket>:<subject>", the subject a
-- wallet, a call + wallet or a client IP. Rows are purged after a day by the
-- reconcile sweep; the privacy policy states that retention.
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key, window_start)
);
create index rate_limits_window_idx on public.rate_limits(window_start);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;
grant select, insert, update, delete on public.rate_limits to service_role;

-- Count one request against `p_key`; true while the window's count is within
-- the limit. One upsert, so concurrent requests cannot both read a stale count.
create function public.hit_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language sql set search_path = public as $$
  insert into rate_limits as r (key, window_start, hits)
  values (
    p_key,
    to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds),
    1
  )
  on conflict (key, window_start) do update set hits = r.hits + 1
  returning hits <= p_limit
$$;
revoke all on function public.hit_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer) to service_role;

-- 3. Grants left open ------------------------------------------------------------

-- These were revoked only from PUBLIC, but Supabase's default privileges grant
-- EXECUTE to anon and authenticated directly. All run as the caller (RLS still
-- applies), so this closes a door that was not open, only unlocked. Only the
-- service role calls them.
revoke execute on function public.replace_workgroup_budgets(uuid, jsonb, text) from anon, authenticated;
revoke execute on function public.replace_workgroup_period_budgets(uuid, jsonb, text, date) from anon, authenticated;
revoke execute on function public.replace_workgroup_dated_budgets(uuid, jsonb, text, date, text) from anon, authenticated;
revoke execute on function public.budget_setup_workspace(uuid) from anon, authenticated;

-- contributors_read is `using (true)` for every role: without a session the
-- anon key could list every wallet with its handle and GitHub login. Signed-in
-- reads are unchanged (they come through community_members embeds).
revoke select on public.contributors from anon;
