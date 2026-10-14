-- Discord voice capture. A community connects its Discord server
-- (call_integrations); while a Discord call runs, snapshots record who is in
-- its voice channel (calls.external_ref = the channel id). An attendee's
-- snapshots_seen is always recomputed from the evidence rows, so a repeated
-- or concurrent snapshot can never inflate it.
--
-- Capture writes down the Discord user id of everyone in the channel, linked
-- to Guild Vault or not. Those ids are nobody else's business: members keep
-- reading the attendee list, but no longer its external_id column.

create table public.call_integrations (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  provider text not null check (provider in ('discord', 'zoom', 'google')),
  -- Discord: the guild (server) id.
  external_account_id text not null,
  -- What the provider calls it (server name), for the settings page.
  label text,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (community_id, provider)
);

create table public.call_snapshots (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  taken_at timestamptz not null default now(),
  source text not null check (source in ('manual', 'cron'))
);
create index call_snapshots_call_idx on public.call_snapshots (call_id, taken_at desc);

create table public.call_snapshot_attendees (
  snapshot_id uuid not null references public.call_snapshots(id) on delete cascade,
  attendee_id uuid not null references public.call_attendees(id) on delete cascade,
  primary key (snapshot_id, attendee_id)
);
create index call_snapshot_attendees_attendee_idx on public.call_snapshot_attendees (attendee_id);

alter table public.call_integrations enable row level security;
alter table public.call_snapshots enable row level security;
alter table public.call_snapshot_attendees enable row level security;
create policy call_integrations_read on public.call_integrations
  for select using (public.is_member(community_id));
create policy call_snapshots_read on public.call_snapshots for select using (exists (
  select 1 from public.calls c where c.id = call_id and public.is_member(c.community_id)));
create policy call_snapshot_attendees_read on public.call_snapshot_attendees for select using (exists (
  select 1 from public.call_snapshots s join public.calls c on c.id = s.call_id
  where s.id = snapshot_id and public.is_member(c.community_id)));
revoke all on public.call_integrations, public.call_snapshots, public.call_snapshot_attendees
  from anon, authenticated, service_role;
grant select on public.call_integrations, public.call_snapshots, public.call_snapshot_attendees to authenticated;
grant select, insert, update, delete on public.call_integrations, public.call_snapshots,
  public.call_snapshot_attendees to service_role;

-- Members read every attendee column except the platform account id.
revoke select on public.call_attendees from authenticated;
grant select (id, call_id, provider, display_name, wallet_address, snapshots_seen, minutes,
  first_seen, last_seen, status, task_id, created_at) on public.call_attendees to authenticated;

-- Record one snapshot: p_present = [{"id": "<discord user id>", "name": "<display name>"}, …].
-- Each person lands on exactly one attendee row of the call:
--   1. their Discord row from an earlier snapshot, else
--   2. the row that already carries their linked wallet (they checked in, or a
--      manager added them): presence counts there, no second row, else
--   3. a new Discord row, with the wallet of their linked account when it is
--      on the community's network and not yet on the call.
-- A linked wallet also joins the community (being in its voice call is the
-- invite, as with the check-in code), so the contributor can see the reward.
create function public.record_call_snapshot(p_call_id uuid, p_source text, p_present jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  c public.calls;
  v_network int;
  v_snapshot uuid;
  v_attendee uuid;
  v_wallet text;
  v_new int := 0;
  r record;
begin
  select * into c from calls where id = p_call_id for update;
  if not found then raise exception 'Call not found' using errcode = 'P0002'; end if;
  select network into v_network from communities where id = c.community_id;

  insert into call_snapshots (call_id, source) values (c.id, p_source) returning id into v_snapshot;

  for r in
    select distinct on (x.id) x.id, coalesce(nullif(trim(x.name), ''), 'Discord user') as name
    from jsonb_to_recordset(coalesce(p_present, '[]'::jsonb)) as x(id text, name text)
    where x.id is not null and x.id <> ''
  loop
    v_attendee := null;
    select i.wallet_address into v_wallet from contributor_identities i
      where i.provider = 'discord' and i.external_id = r.id
        and (i.wallet_address like 'addr_test%') = (v_network = 0);

    select a.id into v_attendee from call_attendees a
      where a.call_id = c.id and a.provider = 'discord' and a.external_id = r.id;
    if v_attendee is null and v_wallet is not null then
      select a.id into v_attendee from call_attendees a
        where a.call_id = c.id and a.wallet_address = v_wallet;
    end if;

    if v_attendee is null then
      insert into call_attendees (call_id, provider, external_id, display_name, wallet_address)
        values (c.id, 'discord', r.id, r.name, v_wallet) returning id into v_attendee;
      v_new := v_new + 1;
    else
      -- A Discord row still waiting for a wallet takes the link made since,
      -- unless the wallet is on the call already. Rewarded rows are frozen.
      update call_attendees a set
          display_name = case when a.provider = 'discord' then r.name else a.display_name end,
          wallet_address = case
            when a.wallet_address is null and v_wallet is not null and not exists (
              select 1 from call_attendees o where o.call_id = c.id and o.wallet_address = v_wallet)
            then v_wallet else a.wallet_address end
        where a.id = v_attendee and a.task_id is null;
    end if;

    if v_wallet is not null then
      insert into community_members (community_id, wallet_address, role)
        values (c.community_id, v_wallet, 'member') on conflict do nothing;
    end if;
    insert into call_snapshot_attendees (snapshot_id, attendee_id)
      values (v_snapshot, v_attendee) on conflict do nothing;
  end loop;

  -- Presence is derived from the evidence, never incremented.
  update call_attendees a set
      snapshots_seen = s.seen, first_seen = least(a.first_seen, s.first_at), last_seen = greatest(a.last_seen, s.last_at)
    from (
      select sa.attendee_id, count(*)::int as seen, min(sn.taken_at) as first_at, max(sn.taken_at) as last_at
      from call_snapshot_attendees sa join call_snapshots sn on sn.id = sa.snapshot_id
      where sn.call_id = c.id group by sa.attendee_id
    ) s
    where a.id = s.attendee_id;

  return jsonb_build_object('snapshotId', v_snapshot,
    'present', (select count(*) from call_snapshot_attendees where snapshot_id = v_snapshot),
    'added', v_new);
end $$;

revoke all on function public.record_call_snapshot(uuid, text, jsonb) from public, authenticated, anon;
grant execute on function public.record_call_snapshot(uuid, text, jsonb) to service_role;
