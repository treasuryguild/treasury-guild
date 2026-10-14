-- Call attendance rewards. A call (Discord, Zoom, Meet or anything else)
-- collects attendees; finalizing it turns the attendees that have a wallet
-- into ordinary native tasks in the call's workgroup: amounts = the call's
-- reward, one 'manual' task_assignees row per wallet, pay_state 'payable'.
-- Every assignee is paid the task's full amounts, so Payday, build-payout and
-- the payout metadata need nothing new.
--
-- Money rules:
--   * a wallet appears once per call (call_attendees_wallet_uq), so nobody is
--     rewarded twice for one call however they were captured;
--   * tasks are created only by finalize_call, in one transaction under a row
--     lock, and only for attendees without a task: a retry creates nothing;
--   * a task holds at most p_chunk wallets (the task editor's assignee cap),
--     split into balanced chunks, because a task cannot span transactions.
-- All writes are service-role; members read through RLS.

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  workgroup_id uuid not null references public.workgroups(id) on delete cascade,
  provider text not null check (provider in ('discord', 'zoom', 'meet', 'manual')),
  title text not null check (length(trim(title)) > 0),
  -- Voice channel id / meeting id / meeting code, for the capture adapters.
  external_ref text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- Reward per attendee, same shape as tasks.amounts: {"ADA":"5","TOKEN":"10"}.
  amounts jsonb not null check (jsonb_typeof(amounts) = 'object' and amounts <> '{}'::jsonb),
  -- Presence threshold for captured ('auto') attendees.
  min_snapshots int not null default 1 check (min_snapshots >= 0),
  min_minutes int not null default 0 check (min_minutes >= 0),
  state text not null default 'open' check (state in ('open', 'finalized')),
  created_by text not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index calls_community_idx on public.calls (community_id, starts_at desc);

-- community_id always follows the workgroup, which never changes.
create function public.calls_set_community() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.workgroup_id is distinct from old.workgroup_id then
    raise exception 'A call stays in its workgroup' using errcode = '23514';
  end if;
  select community_id into new.community_id from workgroups where id = new.workgroup_id;
  if new.community_id is null then
    raise exception 'Workgroup not found' using errcode = '23503';
  end if;
  return new;
end $$;
create trigger calls_set_community before insert or update on public.calls
  for each row execute function public.calls_set_community();

create table public.call_attendees (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  provider text not null check (provider in ('discord', 'zoom', 'meet', 'checkin', 'manual')),
  -- Platform user id (checkin: the wallet); null for name-only rows.
  external_id text,
  display_name text not null,
  wallet_address text references public.contributors(wallet_address),
  snapshots_seen int not null default 0,
  minutes int not null default 0,
  first_seen timestamptz,
  last_seen timestamptz,
  -- auto = subject to the call's threshold, confirmed = a manager's override,
  -- excluded = never paid.
  status text not null default 'auto' check (status in ('auto', 'confirmed', 'excluded')),
  -- The attendance task that pays this attendee. Deleting the task frees the
  -- attendee for the next finalize.
  task_id uuid references public.tasks(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index call_attendees_external_uq
  on public.call_attendees (call_id, provider, external_id) where external_id is not null;
-- One reward per wallet per call.
create unique index call_attendees_wallet_uq
  on public.call_attendees (call_id, wallet_address) where wallet_address is not null;
create index call_attendees_call_idx on public.call_attendees (call_id);
create index call_attendees_task_idx on public.call_attendees (task_id) where task_id is not null;

create table public.call_tasks (
  call_id uuid not null references public.calls(id) on delete cascade,
  task_id uuid not null unique references public.tasks(id) on delete cascade,
  chunk_index int not null,
  created_at timestamptz not null default now(),
  primary key (call_id, task_id)
);

-- The check-in code is shown to managers for the whole call, so it is kept
-- readable, but away from member reads: service-role routes only.
create table public.call_checkin_codes (
  call_id uuid primary key references public.calls(id) on delete cascade,
  code text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

-- Remembered name -> wallet matches a manager confirmed (Zoom guests and
-- pasted lists carry only a typed name). Unverified by nature: it only
-- prefills, a manager still reviews the list before finalizing.
create table public.call_name_aliases (
  community_id uuid not null references public.communities(id) on delete cascade,
  normalized_name text not null,
  wallet_address text not null references public.contributors(wallet_address),
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (community_id, normalized_name)
);

alter table public.calls enable row level security;
alter table public.call_attendees enable row level security;
alter table public.call_tasks enable row level security;
alter table public.call_checkin_codes enable row level security;
alter table public.call_name_aliases enable row level security;
-- call_checkin_codes and call_name_aliases: service-role only (no policies).

create policy calls_read on public.calls for select using (public.is_member(community_id));
create policy call_attendees_read on public.call_attendees for select using (exists (
  select 1 from public.calls c where c.id = call_id and public.is_member(c.community_id)));
create policy call_tasks_read on public.call_tasks for select using (exists (
  select 1 from public.calls c where c.id = call_id and public.is_member(c.community_id)));

revoke all on public.calls, public.call_attendees, public.call_tasks,
  public.call_checkin_codes, public.call_name_aliases from anon, authenticated, service_role;
grant select on public.calls, public.call_attendees, public.call_tasks to authenticated;
grant select, insert, update, delete on public.calls, public.call_attendees, public.call_tasks,
  public.call_checkin_codes, public.call_name_aliases to service_role;

-- Create the attendance task(s) for the given attendees. The route decides who
-- qualifies (presence threshold); this re-checks what money depends on: the
-- attendee belongs to the call, has a wallet, is not excluded and has no task
-- yet. Returns the new task ids and how many attendees are still unpaid.
create function public.finalize_call(
  p_call_id uuid, p_actor text, p_attendee_ids uuid[], p_chunk int, p_bounty_lovelace bigint
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  c public.calls;
  w public.workgroups;
  v_ids uuid[];
  v_n int;
  v_chunks int;
  v_offset int;
  v_column uuid;
  v_task uuid;
  v_tasks uuid[] := '{}';
  v_title text;
  v_remaining int;
  k int;
begin
  select * into c from calls where id = p_call_id for update;
  if not found then raise exception 'Call not found' using errcode = 'P0002'; end if;
  select * into w from workgroups where id = c.workgroup_id;
  if w.archived_at is not null then
    raise exception 'Restore this workgroup before making changes' using errcode = '23514';
  end if;
  if not exists (select 1 from community_members where community_id = c.community_id
      and wallet_address = p_actor and role in ('owner', 'admin'))
    and not exists (select 1 from workgroup_leads where workgroup_id = c.workgroup_id
      and wallet_address = p_actor) then
    raise exception 'Only admins and workgroup leads can finalize a call' using errcode = '42501';
  end if;
  if p_chunk is null or p_chunk < 1 then
    raise exception 'Chunk size must be positive' using errcode = '23514';
  end if;

  select array_agg(a.id order by a.created_at, a.id) into v_ids
  from call_attendees a
  where a.call_id = c.id and a.id = any(p_attendee_ids)
    and a.wallet_address is not null and a.task_id is null and a.status <> 'excluded';
  v_n := coalesce(array_length(v_ids, 1), 0);

  if v_n > 0 then
    v_chunks := ceil(v_n::numeric / p_chunk)::int;
    select count(*) into v_offset from call_tasks where call_id = c.id;
    -- Native boards show the task in their payable column; without one the
    -- task is still listed on Payday.
    select id into v_column from board_columns
      where workgroup_id = c.workgroup_id and marks_payable order by position limit 1;
    for k in 0..v_chunks - 1 loop
      v_title := 'Call: ' || trim(c.title) || ', ' || to_char(c.starts_at at time zone 'UTC', 'YYYY-MM-DD');
      if v_offset + v_chunks > 1 then
        v_title := v_title || ' (' || (v_offset + k + 1) || ')';
      end if;
      -- number and community_id come from assign_task_number; budget_month is
      -- stamped by build-payout.
      insert into tasks (workgroup_id, source, title, body, amounts, bounty_lovelace,
          pay_state, audited, column_id)
        values (c.workgroup_id, 'native', v_title,
          'Attendance reward for the call "' || trim(c.title) || '". Created from the Calls page; every assignee attended.',
          c.amounts, p_bounty_lovelace, 'payable', true, v_column)
        returning id into v_task;
      -- Balanced chunks: 41 attendees at 20 per task -> 14 + 14 + 13.
      insert into task_assignees (task_id, source, wallet_address, position)
        select v_task, 'manual', a.wallet_address, (row_number() over (order by x.ord) - 1)::int
        from unnest(v_ids) with ordinality x(id, ord)
        join call_attendees a on a.id = x.id
        where ((x.ord - 1) * v_chunks) / v_n = k;
      update call_attendees a set task_id = v_task
        from unnest(v_ids) with ordinality x(id, ord)
        where a.id = x.id and ((x.ord - 1) * v_chunks) / v_n = k;
      insert into call_tasks (call_id, task_id, chunk_index) values (c.id, v_task, v_offset + k);
      v_tasks := array_append(v_tasks, v_task);
    end loop;
  end if;

  select count(*) into v_remaining from call_attendees
    where call_id = c.id and task_id is null and status <> 'excluded';
  update calls set state = case
      when v_remaining = 0 and exists (select 1 from call_tasks where call_id = c.id) then 'finalized'
      else 'open' end
    where id = c.id;

  return jsonb_build_object('taskIds', to_jsonb(v_tasks), 'paid', v_n, 'remaining', v_remaining);
end $$;

revoke all on function public.finalize_call(uuid, text, uuid[], int, bigint) from public, authenticated, anon;
grant execute on function public.finalize_call(uuid, text, uuid[], int, bigint) to service_role;
