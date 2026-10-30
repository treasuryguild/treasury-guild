-- Lead changes while the workgroup kind is on. A proposal of kind 'lead'
-- adds and removes leads of one existing workgroup. There is no
-- governance_settings row for it: it is available exactly when the workgroup
-- kind is on, and its rules are frozen by the app (lazy consensus of the
-- current leads, or of the admins when none of them can object). One such
-- proposal may be open per workgroup. An admin can still remove a lead
-- immediately; that writes workgroup_lead_overrides, which members can read.

-- 1. Kind ----------------------------------------------------------------------

alter table public.proposals drop constraint if exists proposals_kind_check;
alter table public.proposals add constraint proposals_kind_check
  check (kind in ('budget', 'workgroup', 'task', 'decision', 'lead'));

-- One open lead change per workgroup. A revise withdraws the old row before
-- inserting, so it does not collide with itself.
create unique index proposals_one_open_lead_uq
  on public.proposals ((payload->'leadChange'->>'workgroupId'))
  where kind = 'lead' and state in ('discussion', 'voting');

-- The same guard with a message, serialised on the workgroup so two creates
-- at once cannot both pass.
create function public.guard_one_open_lead_change() returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  v_wg text := new.payload->'leadChange'->>'workgroupId';
begin
  if new.kind <> 'lead' or new.state not in ('discussion', 'voting') then return new; end if;
  if v_wg is null or v_wg !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return new;
  end if;
  perform 1 from workgroups where id = v_wg::uuid for update;
  if exists (
    select 1 from proposals
    where kind = 'lead' and state in ('discussion', 'voting')
      and payload->'leadChange'->>'workgroupId' = v_wg
      and id is distinct from new.id
  ) then
    raise exception 'This workgroup already has an open lead change' using errcode = '23505';
  end if;
  return new;
end $$;

create trigger proposals_one_open_lead
  before insert or update of kind, state, payload on public.proposals
  for each row execute function public.guard_one_open_lead_change();

-- 2. Electorate: the current leads of the workgroups concerned ----------------

create or replace function public.proposal_electorate(
  p_community_id uuid, p_electorate text, p_activity_months int, p_min_member_days int,
  p_workgroup_ids uuid[], p_cutoff timestamptz
) returns table(wallet_address text) language sql stable security invoker set search_path = public as $$
  with m as (
    select cm.wallet_address, cm.role from community_members cm
    where cm.community_id = p_community_id
      and cm.created_at <= p_cutoff - make_interval(days => coalesce(p_min_member_days, 0))
  ),
  since as (select p_cutoff - make_interval(months => coalesce(p_activity_months, 12)) as since_at),
  sel as (
    select case when p_electorate = 'workgroup' and coalesce(cardinality(p_workgroup_ids), 0) = 0
      then 'contributors' else p_electorate end as e
  ),
  paid as (
    select p.contributor_wallet as wallet, t.workgroup_id from payouts p
      join transactions tx on tx.id = p.transaction_id and tx.state = 2
      join tasks t on t.id = p.task_id
      where t.community_id = p_community_id
        and coalesce(tx.submitted_at, tx.created_at) >= (select since_at from since)
  ),
  eligible as (
    select m.wallet_address from m, sel where sel.e = 'members'
    union
    select m.wallet_address from m, sel where sel.e = 'admins' and m.role in ('owner', 'admin')
    union
    select m.wallet_address from m, sel where sel.e = 'managers' and (m.role in ('owner', 'admin')
      or exists (select 1 from workgroup_leads l join workgroups w on w.id = l.workgroup_id
        where w.community_id = p_community_id and l.wallet_address = m.wallet_address))
    union
    select m.wallet_address from m, sel where sel.e = 'workgroup' and (
      exists (select 1 from workgroup_leads l
        where l.workgroup_id = any(p_workgroup_ids) and l.wallet_address = m.wallet_address)
      or exists (select 1 from paid where paid.workgroup_id = any(p_workgroup_ids) and paid.wallet = m.wallet_address)
      or exists (select 1 from task_assignees a join tasks t on t.id = a.task_id
        where t.workgroup_id = any(p_workgroup_ids) and a.wallet_address = m.wallet_address
          and t.created_at >= (select since_at from since)))
    union
    select m.wallet_address from m, sel where sel.e = 'contributors' and (
      exists (select 1 from paid where paid.wallet = m.wallet_address)
      or exists (select 1 from payments pm join transactions tx on tx.id = pm.transaction_id and tx.state = 2
        where pm.community_id = p_community_id and pm.recipient_treasury_id is null
          and pm.recipient_wallet = m.wallet_address
          and coalesce(tx.submitted_at, tx.created_at) >= (select since_at from since)))
    union
    -- leads: current leads of the concerned workgroups, and no one else.
    select m.wallet_address from m, sel where sel.e = 'leads' and exists (
      select 1 from workgroup_leads l
      where l.workgroup_id = any(p_workgroup_ids) and l.wallet_address = m.wallet_address)
  )
  select wallet_address from eligible
$$;

-- 3. Apply ---------------------------------------------------------------------

create function public.apply_lead_proposal(p public.proposals) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_spec jsonb := p.payload->'leadChange';
  v_id uuid := (v_spec->>'workgroupId')::uuid;
  w public.workgroups;
begin
  select * into w from workgroups where id = v_id for update;
  if not found or w.community_id <> p.community_id then
    raise exception 'The workgroup of this lead change no longer exists' using errcode = '23514';
  end if;
  if w.archived_at is not null then
    raise exception 'Restore the workgroup % before changing its leads', w.name using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(v_spec->'add', '[]')) l
    where not exists (select 1 from community_members
      where community_id = p.community_id and wallet_address = l)
  ) then
    raise exception 'A proposed lead is no longer a member' using errcode = '23514';
  end if;
  insert into workgroup_leads(workgroup_id, wallet_address)
    select distinct v_id, l from jsonb_array_elements_text(coalesce(v_spec->'add', '[]')) l
    on conflict do nothing;
  delete from workgroup_leads
    where workgroup_id = v_id
      and wallet_address in (select l from jsonb_array_elements_text(coalesce(v_spec->'remove', '[]')) l);
  return jsonb_build_object('workgroupId', v_id);
end $$;

create or replace function public.execute_proposal(p_id uuid, p_actor text default null)
returns text language plpgsql security invoker set search_path = public as $$
declare
  p public.proposals;
  v_result jsonb;
  v_error text;
  v_code text;
begin
  select * into p from proposals where id = p_id for update;
  if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
  if p.state <> 'passed' then raise exception 'Only a passed proposal is carried out' using errcode = '23514'; end if;
  if p.execution_state not in ('pending', 'failed') then return p.execution_state; end if;
  if p.execution_state = 'failed' and p_actor is null then return 'failed'; end if;
  begin
    perform set_config('treasury_guild.proposal_apply', p.id::text, true);
    if p.kind = 'budget' then
      perform public.run_budget_steps(
        (select coalesce(jsonb_agg(jsonb_build_object('workgroupId', b.workgroup_id, 'treasuryId', b.treasury_id,
          'baseRevision', b.base_revision)), '[]') from proposal_budget_owners b where b.proposal_id = p.id),
        coalesce(p.payload->'steps', '[]'), p.proposer, 'Proposal #' || p.number);
    elsif p.kind = 'workgroup' then
      v_result := public.apply_workgroup_proposal(p);
    elsif p.kind = 'task' then
      v_result := public.apply_task_proposal(p);
    elsif p.kind = 'lead' then
      v_result := public.apply_lead_proposal(p);
    else
      raise exception 'Proposals of this kind are not carried out' using errcode = '23514';
    end if;
    update proposals set execution_state = 'applied', executed_at = now(), execution_error = null,
      execution_result = v_result where id = p.id;
    insert into proposal_events(proposal_id, community_id, action, actor, detail)
      values (p.id, p.community_id, 'executed', p_actor, v_result);
  exception when others then
    get stacked diagnostics v_error = message_text, v_code = returned_sqlstate;
    update proposals set execution_state = 'failed', execution_error = left(v_error, 500) where id = p.id;
    insert into proposal_events(proposal_id, community_id, action, actor, detail)
      values (p.id, p.community_id, 'execution_failed', p_actor, jsonb_build_object('code', v_code, 'message', left(v_error, 500)));
  end;
  perform set_config('treasury_guild.proposal_apply', '', true);
  perform deactivate_proposal_budget_owners(p.id);
  return (select execution_state from proposals where id = p.id);
end $$;

-- 4. An admin removes a lead immediately --------------------------------------

create table public.workgroup_lead_overrides (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  workgroup_id uuid not null references public.workgroups(id) on delete cascade,
  wallet_address text not null,
  actor text not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index workgroup_lead_overrides_community_idx
  on public.workgroup_lead_overrides (community_id, created_at desc);

alter table public.workgroup_lead_overrides enable row level security;
create policy workgroup_lead_overrides_read on public.workgroup_lead_overrides
  for select using (public.is_member(community_id));

revoke all on public.workgroup_lead_overrides from anon, authenticated, service_role;
grant select on public.workgroup_lead_overrides to authenticated;
grant select, insert, update, delete on public.workgroup_lead_overrides to service_role;

create function public.remove_workgroup_lead_override(
  p_workgroup_id uuid, p_wallet text, p_actor text, p_reason text
) returns void language plpgsql security invoker set search_path = public as $$
declare
  w public.workgroups;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v_reason) not between 1 and 500 then
    raise exception 'Give a reason of at most 500 characters' using errcode = '23514';
  end if;
  select * into w from workgroups where id = p_workgroup_id for update;
  if not found then raise exception 'Workgroup not found' using errcode = 'P0002'; end if;
  if w.archived_at is not null then
    raise exception 'Restore the workgroup % before changing its leads', w.name using errcode = '23514';
  end if;
  delete from workgroup_leads where workgroup_id = w.id and wallet_address = p_wallet;
  if not found then
    raise exception 'That wallet is not a lead of this workgroup' using errcode = '23514';
  end if;
  insert into workgroup_lead_overrides(community_id, workgroup_id, wallet_address, actor, reason)
    values (w.community_id, w.id, p_wallet, p_actor, v_reason);
end $$;

revoke all on function public.guard_one_open_lead_change() from public, anon, authenticated;
revoke all on function public.apply_lead_proposal(public.proposals) from public, anon, authenticated;
revoke all on function public.remove_workgroup_lead_override(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.guard_one_open_lead_change() to service_role;
grant execute on function public.apply_lead_proposal(public.proposals) to service_role;
grant execute on function public.remove_workgroup_lead_override(uuid, text, text, text) to service_role;
