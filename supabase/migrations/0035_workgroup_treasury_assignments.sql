-- Dated workgroup → treasury routing. A workgroup's payment wallet is a
-- timeline (like budget setups): each row says which treasury pays the
-- workgroup's tasks from the budget period starting at starts_on (null = any
-- community wallet). A change takes effect at a period boundary, so one
-- period's spending never spans two wallets; the current period is allowed
-- only while nothing has been paid in it from another wallet.
--
-- workgroups.treasury_id stays as the cached value for the current period,
-- written only by the two functions below (the browser column grant goes).
-- Past payouts keep their own transactions.treasury_id; nothing is
-- re-attributed.

create table workgroup_treasury_assignments (
  id uuid primary key default gen_random_uuid(),
  workgroup_id uuid not null references workgroups(id) on delete cascade,
  -- null = any community wallet
  treasury_id uuid references treasuries(id) on delete set null,
  starts_on date not null check (extract(day from starts_on) = 1),
  reason text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (workgroup_id, starts_on)
);
create index workgroup_treasury_assignments_workgroup_idx
  on workgroup_treasury_assignments(workgroup_id, starts_on desc);

alter table workgroup_treasury_assignments enable row level security;
create policy workgroup_treasury_assignments_read on workgroup_treasury_assignments
  for select using (public.is_member(public.workgroup_community(workgroup_id)));
revoke all on workgroup_treasury_assignments from anon, authenticated, service_role;
grant select on workgroup_treasury_assignments to authenticated;
grant select, insert, update, delete on workgroup_treasury_assignments to service_role;

-- Existing routings become the first row of each timeline.
insert into workgroup_treasury_assignments(workgroup_id, treasury_id, starts_on, created_by)
select id, treasury_id, date '1000-01-01', 'migration'
from workgroups where treasury_id is not null;

-- The browser keeps editing name/description/kind; the wallet goes through
-- set_workgroup_treasury (service role) so every change is dated and logged.
revoke insert, update on public.workgroups from authenticated;
grant insert (community_id, name, description, kind) on public.workgroups to authenticated;
grant update (name, description, kind) on public.workgroups to authenticated;

-- The budget period containing today for a workgroup: its setup in force
-- today decides monthly or quarterly (no setup = monthly), like cadenceAt.
create function public.workgroup_routing_period(p_workgroup_id uuid)
returns table (cadence text, current_start date, next_start date)
language sql stable security invoker set search_path = public as $$
  with today as (select (now() at time zone 'UTC')::date as d),
  setup as (
    select coalesce((select s.cadence from budget_setups s, today
      where s.workgroup_id = p_workgroup_id and s.starts_on <= today.d
      order by s.starts_on desc limit 1), 'monthly') as cadence
  ),
  period as (
    select setup.cadence,
      case when setup.cadence = 'quarterly' then date_trunc('quarter', today.d)::date
        else date_trunc('month', today.d)::date end as current_start
    from setup, today
  )
  select cadence, current_start,
    (current_start + case when cadence = 'quarterly' then interval '3 months'
      else interval '1 month' end)::date as next_start
  from period
$$;

-- Payouts of the workgroup attributed to [p_start, p_end) that were paid from
-- a wallet other than p_treasury_id. Attribution follows the task's budget
-- month, or the submission month for tasks paid before budget months existed
-- (budgetAttributionTime). Rejected transactions never count.
create function public.workgroup_period_paid_elsewhere(
  p_workgroup_id uuid, p_treasury_id uuid, p_start date, p_end date
) returns boolean language sql stable security invoker set search_path = public as $$
  select exists (
    select 1 from payouts p
      join tasks t on t.id = p.task_id
      join transactions tx on tx.id = p.transaction_id
    where t.workgroup_id = p_workgroup_id and tx.state <> 3
      and tx.treasury_id is distinct from p_treasury_id
      and coalesce(t.budget_month,
        date_trunc('month', coalesce(tx.submitted_at, tx.created_at) at time zone 'UTC')::date)
        >= p_start
      and coalesce(t.budget_month,
        date_trunc('month', coalesce(tx.submitted_at, tx.created_at) at time zone 'UTC')::date)
        < p_end
  )
$$;

create function public.set_workgroup_treasury(
  p_workgroup_id uuid, p_treasury_id uuid, p_effective text, p_actor text, p_reason text default null
) returns date language plpgsql security invoker set search_path = public as $$
declare
  w public.workgroups;
  v_period record;
  v_starts_on date;
begin
  select * into w from workgroups where id = p_workgroup_id for update;
  if not found then raise exception 'Workgroup not found' using errcode = 'P0002'; end if;
  if w.archived_at is not null then
    raise exception 'Restore this workgroup before changing its wallet' using errcode = '23514';
  end if;
  if not exists (select 1 from community_members where community_id = w.community_id
    and wallet_address = p_actor and role in ('owner','admin')) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;
  if p_treasury_id is not null and not exists (
    select 1 from treasuries where id = p_treasury_id and community_id = w.community_id
  ) then
    raise exception 'Choose a wallet of this community' using errcode = '23514';
  end if;
  select * into v_period from workgroup_routing_period(w.id);
  if p_effective = 'current' then
    v_starts_on := v_period.current_start;
    if workgroup_period_paid_elsewhere(w.id, p_treasury_id, v_period.current_start, v_period.next_start) then
      raise exception 'This period already has payouts from another wallet. The change can start next period.'
        using errcode = '23514';
    end if;
  elsif p_effective = 'next' then
    v_starts_on := v_period.next_start;
  else
    raise exception 'Choose when the wallet change takes effect' using errcode = '23514';
  end if;
  if exists (select 1 from workgroup_treasury_assignments
    where workgroup_id = w.id and starts_on > v_starts_on) then
    raise exception 'A later wallet change is already scheduled' using errcode = '23514';
  end if;
  -- Same start date: replace the row, which is also how a scheduled change is
  -- edited or cancelled (set it back to the wallet in force).
  insert into workgroup_treasury_assignments(workgroup_id, treasury_id, starts_on, reason, created_by)
    values (w.id, p_treasury_id, v_starts_on, nullif(trim(p_reason), ''), p_actor)
    on conflict (workgroup_id, starts_on) do update
      set treasury_id = excluded.treasury_id, reason = excluded.reason,
          created_by = excluded.created_by, created_at = now();
  if v_starts_on <= v_period.current_start and w.treasury_id is distinct from p_treasury_id then
    update workgroups set treasury_id = p_treasury_id where id = w.id;
  end if;
  return v_starts_on;
end $$;

-- Cache the routing in force today on workgroups.treasury_id. Run by the
-- reconcile sweep, so a scheduled change lands within 15 minutes of its
-- period start. Archived workgroups are frozen (lifecycle guard) and catch
-- up after restore.
create function public.apply_workgroup_treasury_assignments() returns integer
language plpgsql security invoker set search_path = public as $$
declare v_count integer;
begin
  update workgroups w set treasury_id = a.treasury_id
  from (
    select distinct on (workgroup_id) workgroup_id, treasury_id
    from workgroup_treasury_assignments
    where starts_on <= (now() at time zone 'UTC')::date
    order by workgroup_id, starts_on desc
  ) a
  where a.workgroup_id = w.id and w.archived_at is null
    and w.treasury_id is distinct from a.treasury_id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- What the wallet dialog needs: the period a change would start in, whether
-- "this period" is still open, and the dated history.
create function public.workgroup_treasury_routing(p_workgroup_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'treasuryId', w.treasury_id,
    'cadence', p.cadence,
    'currentStart', p.current_start,
    'nextStart', p.next_start,
    -- Any payout this period (a null wallet is distinct from every real one).
    'currentBlocked', workgroup_period_paid_elsewhere(w.id, null, p.current_start, p.next_start),
    'history', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'treasuryId', a.treasury_id, 'startsOn', a.starts_on,
        'reason', a.reason, 'createdBy', a.created_by, 'createdAt', a.created_at
      ) order by a.starts_on desc)
      from workgroup_treasury_assignments a where a.workgroup_id = w.id), '[]'::jsonb)
  )
  from workgroups w, workgroup_routing_period(w.id) p
  where w.id = p_workgroup_id
$$;

revoke all on function public.workgroup_routing_period(uuid) from public, authenticated, anon;
revoke all on function public.workgroup_period_paid_elsewhere(uuid,uuid,date,date) from public, authenticated, anon;
revoke all on function public.set_workgroup_treasury(uuid,uuid,text,text,text) from public, authenticated, anon;
revoke all on function public.apply_workgroup_treasury_assignments() from public, authenticated, anon;
revoke all on function public.workgroup_treasury_routing(uuid) from public, authenticated, anon;
grant execute on function public.workgroup_routing_period(uuid) to service_role;
grant execute on function public.workgroup_period_paid_elsewhere(uuid,uuid,date,date) to service_role;
grant execute on function public.set_workgroup_treasury(uuid,uuid,text,text,text) to service_role;
grant execute on function public.apply_workgroup_treasury_assignments() to service_role;
grant execute on function public.workgroup_treasury_routing(uuid) to service_role;

select public.apply_workgroup_treasury_assignments();
