-- Archive a treasury without deleting it. The row, its address and its
-- transactions stay, so on-chain anchor links and payout history keep one
-- home. Finished project wallets leave the active lists; restoring the same
-- script brings that row back. There is no delete action for a wallet that
-- has already built a transaction.

alter table public.treasuries
  add column archived_at timestamptz,
  add column archived_by text;

comment on column public.treasuries.archived_at is
  'When an admin archived this treasury. Null while it can be chosen for new payouts, mints and anchors.';
comment on column public.treasuries.archived_by is
  'Wallet of the admin who archived it; cleared on restore.';

-- Why archive cannot proceed yet. Empty when it can. A future payment-wallet
-- assignment counts, and so does the assignment in force today even when the
-- workgroups.treasury_id cache has not caught up.
create function public.treasury_lifecycle_status(p_treasury_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  t public.treasuries;
  v_blockers text[] := '{}';
  v_names text;
  v_today date := (now() at time zone 'UTC')::date;
begin
  select * into t from treasuries where id = p_treasury_id;
  if not found then return null; end if;
  if exists (select 1 from communities c where c.primary_treasury_id = t.id) then
    v_blockers := array_append(v_blockers, 'Set another treasury as primary first');
  end if;
  if exists (select 1 from transactions tx where tx.treasury_id = t.id and tx.state in (0, 1)) then
    v_blockers := array_append(v_blockers, 'Submit, reject or delete its transaction that is still in progress');
  end if;
  select string_agg(w.name, ', ' order by w.name) into v_names
  from workgroups w
  where w.archived_at is null and w.community_id = t.community_id and (
    w.treasury_id = t.id
    or exists (
      select 1 from workgroup_treasury_assignments a
      where a.workgroup_id = w.id and a.treasury_id = t.id and a.starts_on > v_today
    )
    or (
      select a.treasury_id from workgroup_treasury_assignments a
      where a.workgroup_id = w.id and a.starts_on <= v_today
      order by a.starts_on desc limit 1
    ) = t.id
  );
  if v_names is not null then
    v_blockers := array_append(v_blockers, format('These workgroups still pay from it: %s', v_names));
  end if;
  return jsonb_build_object('archivedAt', t.archived_at, 'blockers', to_jsonb(v_blockers));
end $$;

create function public.change_treasury_lifecycle(p_treasury_id uuid, p_action text, p_actor text)
returns void language plpgsql security invoker set search_path = public as $$
declare
  t public.treasuries;
  v_status jsonb;
  v_blocker text;
begin
  select * into t from treasuries where id = p_treasury_id for update;
  if not found then raise exception 'Treasury not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from community_members
    where community_id = t.community_id and wallet_address = p_actor and role in ('owner', 'admin')
  ) then
    raise exception 'Requires admin role' using errcode = '42501';
  end if;
  if p_action = 'archive' then
    if t.archived_at is not null then return; end if;
    v_status := public.treasury_lifecycle_status(p_treasury_id);
    select b into v_blocker from jsonb_array_elements_text(v_status->'blockers') as b limit 1;
    if v_blocker is not null then
      raise exception '%', v_blocker using errcode = '23514';
    end if;
    update treasuries set archived_at = now(), archived_by = p_actor where id = t.id;
  elsif p_action = 'restore' then
    if t.archived_at is null then return; end if;
    update treasuries set archived_at = null, archived_by = null where id = t.id;
  else
    raise exception 'Choose archive or restore' using errcode = '23514';
  end if;
end $$;

-- Holds for service role too: a raw update cannot archive a treasury the
-- status still blocks, and cannot edit one that is archived. Restore (clearing
-- archived_at) stays allowed.
create function public.guard_treasury_lifecycle() returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  v_status jsonb;
  v_blocker text;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from transactions where treasury_id = old.id) then
      raise exception 'This treasury has transactions. Archive it instead.' using errcode = '23514';
    end if;
    return old;
  end if;
  if old.archived_at is null and new.archived_at is not null then
    v_status := public.treasury_lifecycle_status(old.id);
    select b into v_blocker from jsonb_array_elements_text(v_status->'blockers') as b limit 1;
    if v_blocker is not null then
      raise exception '%', v_blocker using errcode = '23514';
    end if;
    return new;
  end if;
  if old.archived_at is not null and new.archived_at is not null and
    (to_jsonb(new) - 'archived_at' - 'archived_by') is distinct from
    (to_jsonb(old) - 'archived_at' - 'archived_by') then
    raise exception 'Restore this treasury before editing it' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger treasuries_guard_lifecycle
  before update or delete on public.treasuries
  for each row execute function public.guard_treasury_lifecycle();

-- A payment wallet cannot be pointed at an archived treasury, including a
-- dated assignment written directly. Null (any community wallet) stays allowed.
create function public.guard_archived_treasury_routing() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if new.treasury_id is not null and exists (
    select 1 from treasuries where id = new.treasury_id and archived_at is not null
  ) then
    raise exception 'Restore this treasury before using it as a payment wallet' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger workgroup_treasury_assignments_archived
  before insert or update of treasury_id on public.workgroup_treasury_assignments
  for each row execute function public.guard_archived_treasury_routing();

-- Same refusal inside the routing RPC, so the error is raised before the write.
create or replace function public.set_workgroup_treasury(
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
  if p_treasury_id is not null and exists (
    select 1 from treasuries where id = p_treasury_id and archived_at is not null
  ) then
    raise exception 'Restore this treasury before using it as a payment wallet' using errcode = '23514';
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

-- Budget saves for an archived treasury are frozen. Workgroup-owned rows
-- (treasury_id null) are untouched. Period plans look up the setup they belong to.
create function public.guard_archived_treasury_budget() returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  v_treasury uuid;
begin
  if tg_table_name = 'budget_plans' then
    select treasury_id into v_treasury from budget_setups where id = new.setup_id;
  else
    v_treasury := new.treasury_id;
  end if;
  if v_treasury is not null and exists (
    select 1 from treasuries where id = v_treasury and archived_at is not null
  ) then
    raise exception 'Restore this treasury before changing its budget' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger budget_setups_archived_treasury
  before insert or update on public.budget_setups
  for each row execute function public.guard_archived_treasury_budget();
create trigger budget_plans_archived_treasury
  before insert or update on public.budget_plans
  for each row execute function public.guard_archived_treasury_budget();

-- The primary treasury is the one whose base signers are admins. An archived
-- wallet cannot be chosen.
create or replace function public.guard_primary_treasury()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.primary_treasury_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.treasuries
    where id = new.primary_treasury_id and community_id = new.id and archived_at is null
  ) then
    if exists (
      select 1 from public.treasuries
      where id = new.primary_treasury_id and community_id = new.id and archived_at is not null
    ) then
      raise exception 'Restore this treasury before making it primary' using errcode = '23514';
    end if;
    raise exception 'primary_treasury_id must be a treasury of this community' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.treasury_lifecycle_status(uuid) from public, anon, authenticated;
revoke all on function public.change_treasury_lifecycle(uuid, text, text) from public, anon, authenticated;
revoke all on function public.guard_treasury_lifecycle() from public, anon, authenticated;
revoke all on function public.guard_archived_treasury_routing() from public, anon, authenticated;
revoke all on function public.guard_archived_treasury_budget() from public, anon, authenticated;
grant execute on function public.treasury_lifecycle_status(uuid) to service_role;
grant execute on function public.change_treasury_lifecycle(uuid, text, text) to service_role;
grant execute on function public.guard_treasury_lifecycle() to service_role;
grant execute on function public.guard_archived_treasury_routing() to service_role;
grant execute on function public.guard_archived_treasury_budget() to service_role;
