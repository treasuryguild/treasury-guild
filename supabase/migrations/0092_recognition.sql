-- Opt-in community recognition: lead endorsements (and later peer kudos) on
-- paid work, scored in seasons. Missing recognition_settings row = off.
-- Never writes tasks, payouts, payments, budgets or membership roles.

-- 1. Settings -----------------------------------------------------------------

create table public.recognition_settings (
  community_id uuid primary key references public.communities(id) on delete cascade,
  enabled boolean not null default false,
  season text not null default 'quarter' check (season in ('month', 'quarter')),
  max_endorsements_per_actor_season int not null default 10
    check (max_endorsements_per_actor_season between 1 and 100),
  show_leaderboard boolean not null default false,
  peer_kudos_enabled boolean not null default false,
  min_member_days_to_kudos int not null default 30
    check (min_member_days_to_kudos between 0 and 365),
  electorate_endorsed boolean not null default false,
  -- Minimum season score (3 per endorsement) to sit in the endorsed electorate.
  endorsed_min_score numeric not null default 3
    check (endorsed_min_score >= 0),
  updated_by text not null,
  updated_at timestamptz not null default now()
);

create table public.recognition_setting_changes (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  actor text not null,
  before_value jsonb,
  after_value jsonb not null,
  changed_at timestamptz not null default now()
);
create index recognition_setting_changes_idx
  on public.recognition_setting_changes(community_id, changed_at desc);

create function public.recognition_enabled(p_community_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from recognition_settings where community_id = p_community_id), false)
$$;

create function public.save_recognition_settings(
  p_community_id uuid, p_settings jsonb, p_actor text
) returns void language plpgsql security invoker set search_path = public as $$
declare
  v_before jsonb;
  v_row public.recognition_settings;
begin
  select to_jsonb(s) into v_before from recognition_settings s
    where community_id = p_community_id for update;
  v_row := jsonb_populate_record(null::public.recognition_settings, p_settings || jsonb_build_object(
    'community_id', p_community_id, 'updated_by', p_actor, 'updated_at', now()));
  insert into recognition_settings select v_row.*
    on conflict (community_id) do update set
      enabled = excluded.enabled,
      season = excluded.season,
      max_endorsements_per_actor_season = excluded.max_endorsements_per_actor_season,
      show_leaderboard = excluded.show_leaderboard,
      peer_kudos_enabled = excluded.peer_kudos_enabled,
      min_member_days_to_kudos = excluded.min_member_days_to_kudos,
      electorate_endorsed = excluded.electorate_endorsed,
      endorsed_min_score = excluded.endorsed_min_score,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;
  insert into recognition_setting_changes(community_id, actor, before_value, after_value)
    select p_community_id, p_actor, v_before, to_jsonb(s) from recognition_settings s
    where community_id = p_community_id;
end $$;

-- 2. Events -------------------------------------------------------------------

create table public.recognition_events (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  kind text not null check (kind in ('endorsement', 'peer_kudos', 'steward', 'season_award')),
  subject_wallet text not null,
  actor_wallet text not null,
  task_id uuid references public.tasks(id) on delete cascade,
  workgroup_id uuid references public.workgroups(id) on delete set null,
  weight numeric not null default 1 check (weight > 0),
  note text check (note is null or char_length(note) <= 500),
  season_key text not null check (char_length(season_key) between 4 and 16),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or char_length(revoke_reason) <= 500),
  revoked_by text,
  check (actor_wallet <> subject_wallet),
  check ((revoked_at is null) = (revoked_by is null))
);

create unique index recognition_events_endorsement_uq
  on public.recognition_events(task_id, subject_wallet)
  where kind = 'endorsement' and revoked_at is null and task_id is not null;

create unique index recognition_events_peer_kudos_uq
  on public.recognition_events(task_id, actor_wallet, subject_wallet)
  where kind = 'peer_kudos' and revoked_at is null and task_id is not null;

create index recognition_events_season_idx
  on public.recognition_events(community_id, season_key, subject_wallet)
  where revoked_at is null;

create index recognition_events_actor_season_idx
  on public.recognition_events(community_id, season_key, actor_wallet, kind)
  where revoked_at is null;

-- 3. Create endorsement -------------------------------------------------------

create function public.create_recognition_endorsement(
  p_task_id uuid,
  p_subject_wallet text,
  p_actor text,
  p_season_key text,
  p_note text default null
) returns uuid language plpgsql security invoker set search_path = public as $$
declare
  t public.tasks;
  s public.recognition_settings;
  v_id uuid;
  v_granted int;
begin
  select * into t from tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'P0002'; end if;

  select * into s from recognition_settings where community_id = t.community_id for share;
  if not found or not s.enabled then
    raise exception 'Recognition is off for this community' using errcode = '42501';
  end if;

  if t.pay_state not in ('paid', 'reconciled') then
    raise exception 'Only paid tasks can be endorsed' using errcode = '23514';
  end if;

  if exists (select 1 from call_tasks where task_id = t.id) then
    raise exception 'Call attendance tasks cannot be endorsed' using errcode = '23514';
  end if;

  if p_actor = p_subject_wallet then
    raise exception 'You cannot endorse yourself' using errcode = '23514';
  end if;

  if not exists (
    select 1 from task_assignees
    where task_id = t.id and wallet_address = p_subject_wallet
  ) then
    raise exception 'That wallet is not an assignee on this task' using errcode = '23514';
  end if;

  if not exists (
    select 1 from community_members
    where community_id = t.community_id and wallet_address = p_actor
      and role in ('owner', 'admin')
  ) and not exists (
    select 1 from workgroup_leads
    where workgroup_id = t.workgroup_id and wallet_address = p_actor
  ) then
    raise exception 'Only admins and workgroup leads can endorse' using errcode = '42501';
  end if;

  select count(*)::int into v_granted from recognition_events
    where community_id = t.community_id and season_key = p_season_key
      and actor_wallet = p_actor and kind = 'endorsement' and revoked_at is null;
  if v_granted >= s.max_endorsements_per_actor_season then
    raise exception 'Season endorsement budget used up' using errcode = '23514';
  end if;

  if exists (
    select 1 from recognition_events
    where task_id = t.id and subject_wallet = p_subject_wallet
      and kind = 'endorsement' and revoked_at is null
  ) then
    raise exception 'This assignee is already endorsed on this task' using errcode = '23514';
  end if;

  insert into recognition_events(
    community_id, kind, subject_wallet, actor_wallet, task_id, workgroup_id,
    weight, note, season_key
  ) values (
    t.community_id, 'endorsement', p_subject_wallet, p_actor, t.id, t.workgroup_id,
    1, nullif(btrim(coalesce(p_note, '')), ''), p_season_key
  ) returning id into v_id;
  return v_id;
end $$;

-- 4. Create peer kudos --------------------------------------------------------

create function public.create_recognition_peer_kudos(
  p_task_id uuid,
  p_subject_wallet text,
  p_actor text,
  p_season_key text,
  p_note text default null
) returns uuid language plpgsql security invoker set search_path = public as $$
declare
  t public.tasks;
  s public.recognition_settings;
  v_id uuid;
  v_granted int;
  v_to_subject int;
  v_member_since timestamptz;
begin
  select * into t from tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'P0002'; end if;

  select * into s from recognition_settings where community_id = t.community_id for share;
  if not found or not s.enabled or not s.peer_kudos_enabled then
    raise exception 'Peer kudos is off for this community' using errcode = '42501';
  end if;

  if t.pay_state not in ('paid', 'reconciled') then
    raise exception 'Only paid tasks can receive kudos' using errcode = '23514';
  end if;

  if exists (select 1 from call_tasks where task_id = t.id) then
    raise exception 'Call attendance tasks cannot receive kudos' using errcode = '23514';
  end if;

  if p_actor = p_subject_wallet then
    raise exception 'You cannot give kudos to yourself' using errcode = '23514';
  end if;

  select created_at into v_member_since from community_members
    where community_id = t.community_id and wallet_address = p_actor;
  if not found then
    raise exception 'Only members can give kudos' using errcode = '42501';
  end if;
  if v_member_since > now() - make_interval(days => s.min_member_days_to_kudos) then
    raise exception 'Membership is too new to give kudos' using errcode = '23514';
  end if;

  if not exists (
    select 1 from task_assignees
    where task_id = t.id and wallet_address = p_subject_wallet
  ) then
    raise exception 'That wallet is not an assignee on this task' using errcode = '23514';
  end if;

  -- Must have been paid at least once this season before giving kudos.
  if not exists (
    select 1 from payouts p
      join transactions tx on tx.id = p.transaction_id and tx.state = 2
      join tasks pt on pt.id = p.task_id
    where pt.community_id = t.community_id and p.contributor_wallet = p_actor
  ) and not exists (
    select 1 from recognition_events
    where community_id = t.community_id and subject_wallet = p_actor
      and kind = 'endorsement' and revoked_at is null
  ) then
    raise exception 'Earn a payout or endorsement before giving kudos' using errcode = '23514';
  end if;

  select count(*)::int into v_granted from recognition_events
    where community_id = t.community_id and season_key = p_season_key
      and actor_wallet = p_actor and kind = 'peer_kudos' and revoked_at is null;
  if v_granted >= 20 then
    raise exception 'Season kudos budget used up' using errcode = '23514';
  end if;

  select count(*)::int into v_to_subject from recognition_events
    where community_id = t.community_id and season_key = p_season_key
      and actor_wallet = p_actor and subject_wallet = p_subject_wallet
      and kind = 'peer_kudos' and revoked_at is null;
  if v_to_subject >= 2 then
    raise exception 'Too many kudos to the same person this season' using errcode = '23514';
  end if;

  if exists (
    select 1 from recognition_events
    where task_id = t.id and actor_wallet = p_actor and subject_wallet = p_subject_wallet
      and kind = 'peer_kudos' and revoked_at is null
  ) then
    raise exception 'You already gave kudos on this task' using errcode = '23514';
  end if;

  insert into recognition_events(
    community_id, kind, subject_wallet, actor_wallet, task_id, workgroup_id,
    weight, note, season_key
  ) values (
    t.community_id, 'peer_kudos', p_subject_wallet, p_actor, t.id, t.workgroup_id,
    1, nullif(btrim(coalesce(p_note, '')), ''), p_season_key
  ) returning id into v_id;
  return v_id;
end $$;

-- 5. Revoke -------------------------------------------------------------------

create function public.revoke_recognition_event(
  p_event_id uuid, p_actor text, p_reason text default null
) returns boolean language plpgsql security invoker set search_path = public as $$
declare
  e public.recognition_events;
begin
  select * into e from recognition_events where id = p_event_id for update;
  if not found then raise exception 'Recognition event not found' using errcode = 'P0002'; end if;
  if e.revoked_at is not null then return false; end if;

  if e.actor_wallet <> p_actor and not exists (
    select 1 from community_members
    where community_id = e.community_id and wallet_address = p_actor
      and role in ('owner', 'admin')
  ) then
    raise exception 'Only the grantor or an admin can revoke' using errcode = '42501';
  end if;

  update recognition_events set
    revoked_at = now(),
    revoked_by = p_actor,
    revoke_reason = nullif(btrim(coalesce(p_reason, '')), '')
  where id = p_event_id;
  return true;
end $$;

-- 6. Endorsed electorate (extends proposal_electorate) -------------------------

alter table public.governance_settings drop constraint if exists governance_settings_electorate_check;
alter table public.governance_settings add constraint governance_settings_electorate_check
  check (electorate in ('members', 'admins', 'managers', 'workgroup', 'contributors', 'endorsed'));

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
  rs as (
    select * from recognition_settings where community_id = p_community_id and enabled and electorate_endorsed
  ),
  -- Current + previous season keys are computed by the caller into activity;
  -- here we use active endorsement/kudos scores in the look-back window.
  scores as (
    select e.subject_wallet as wallet,
      sum(case when e.kind = 'endorsement' then 3
               when e.kind = 'peer_kudos' then 0.25
               else 0 end) as score
    from recognition_events e
    where e.community_id = p_community_id and e.revoked_at is null
      and e.created_at >= (select since_at from since)
      and e.kind in ('endorsement', 'peer_kudos')
    group by e.subject_wallet
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
    select m.wallet_address from m, sel where sel.e = 'leads' and exists (
      select 1 from workgroup_leads l
      where l.workgroup_id = any(p_workgroup_ids) and l.wallet_address = m.wallet_address)
    union
    select m.wallet_address from m, sel, rs
    where sel.e = 'endorsed'
      and exists (
        select 1 from scores sc
        where sc.wallet = m.wallet_address and sc.score >= rs.endorsed_min_score)
  )
  select wallet_address from eligible
$$;

-- 7. RLS + grants -------------------------------------------------------------

alter table public.recognition_settings enable row level security;
alter table public.recognition_setting_changes enable row level security;
alter table public.recognition_events enable row level security;

create policy recognition_settings_read on public.recognition_settings for select
  using (public.is_member(community_id));
create policy recognition_setting_changes_read on public.recognition_setting_changes for select
  using (public.is_member(community_id));
create policy recognition_events_read on public.recognition_events for select
  using (public.is_member(community_id));

revoke all on public.recognition_settings, public.recognition_setting_changes, public.recognition_events
  from public, anon, authenticated;
grant select on public.recognition_settings, public.recognition_setting_changes, public.recognition_events
  to authenticated;
grant select, insert, update, delete on public.recognition_settings, public.recognition_setting_changes,
  public.recognition_events to service_role;

revoke all on function public.recognition_enabled(uuid) from public, anon, authenticated;
grant execute on function public.recognition_enabled(uuid) to service_role;

revoke all on function public.save_recognition_settings(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.save_recognition_settings(uuid, jsonb, text) to service_role;

revoke all on function public.create_recognition_endorsement(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_recognition_endorsement(uuid, text, text, text, text)
  to service_role;

revoke all on function public.create_recognition_peer_kudos(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_recognition_peer_kudos(uuid, text, text, text, text)
  to service_role;

revoke all on function public.revoke_recognition_event(uuid, text, text) from public, anon, authenticated;
grant execute on function public.revoke_recognition_event(uuid, text, text) to service_role;
