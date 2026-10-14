-- Minutes-based capture (Zoom now, Google Meet next). Presence arrives as
-- sessions: a participant joined at, left at. Zoom sends them twice, live as
-- webhooks and afterwards as the meeting's participant report, so sessions are
-- evidence that may overlap: an attendee's minutes are always recomputed as
-- the UNION of their sessions, clipped to the call's start and end. Recording
-- the same session again, or both sources, never adds a minute.
--
-- The host account a community connects (call_integrations, provider 'zoom')
-- needs OAuth tokens to read the report. They live apart from the member-
-- readable connection row, with no policies: service-role only.

create table public.call_integration_secrets (
  integration_id uuid primary key references public.call_integrations(id) on delete cascade,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.call_integration_secrets enable row level security;
-- service-role only (no policies)
revoke all on public.call_integration_secrets from anon, authenticated, service_role;
grant select, insert, update, delete on public.call_integration_secrets to service_role;

-- Set once the participant report of an ended call has been read (or turned
-- out to be unavailable): the sweep does not come back to it.
alter table public.calls add column captured_at timestamptz;

create table public.call_attendee_sessions (
  id uuid primary key default gen_random_uuid(),
  attendee_id uuid not null references public.call_attendees(id) on delete cascade,
  joined_at timestamptz not null,
  -- Null while the participant is still in the meeting.
  left_at timestamptz,
  -- What makes the evidence unique: redelivered webhooks and repeated sweeps
  -- land on the same row.
  source_key text not null unique,
  check (left_at is null or left_at >= joined_at)
);
create index call_attendee_sessions_attendee_idx on public.call_attendee_sessions (attendee_id);

alter table public.call_attendee_sessions enable row level security;
create policy call_attendee_sessions_read on public.call_attendee_sessions for select using (exists (
  select 1 from public.call_attendees a join public.calls c on c.id = a.call_id
  where a.id = attendee_id and public.is_member(c.community_id)));
revoke all on public.call_attendee_sessions from anon, authenticated, service_role;
grant select on public.call_attendee_sessions to authenticated;
grant select, insert, update, delete on public.call_attendee_sessions to service_role;

-- Minutes of every attendee of the call that has sessions: the union of their
-- sessions inside starts_at..ends_at. A session still open counts up to now
-- (at most the call's end). Rewarded rows keep counting; it changes nothing
-- for them.
create function public.recompute_call_minutes(p_call_id uuid) returns void
language plpgsql security invoker set search_path = public as $$
declare c public.calls;
begin
  select * into c from calls where id = p_call_id;
  if not found then raise exception 'Call not found' using errcode = 'P0002'; end if;
  update call_attendees a set
      minutes = coalesce((
        select floor(extract(epoch from sum(upper(r) - lower(r))) / 60)::int from unnest(s.present) r), 0),
      first_seen = least(a.first_seen, s.first_at),
      last_seen = greatest(a.last_seen, s.last_at)
    from (
      select x.attendee_id, min(x.joined_at) as first_at, max(coalesce(x.left_at, x.joined_at)) as last_at,
        range_agg(tstzrange(x.from_at, x.to_at)) filter (where x.from_at < x.to_at) as present
      from (
        select se.attendee_id, se.joined_at, se.left_at,
          greatest(se.joined_at, c.starts_at) as from_at,
          least(coalesce(se.left_at, now()), c.ends_at) as to_at
        from call_attendee_sessions se join call_attendees at on at.id = se.attendee_id
        where at.call_id = c.id
      ) x group by x.attendee_id
    ) s
    where a.id = s.attendee_id;
end $$;

-- Record presence evidence of a Zoom / Meet call. p_sessions is a list of
--   {"key": participant key, "name": display name, "wallet": suggested wallet or null,
--    "joined": timestamp or null, "left": timestamp or null, "source": unique session key}
-- With "joined" the session is upserted by "source" (a later "left" closes it).
-- With only "left" (a live leave event) the participant's open session is closed.
-- People are resolved to one attendee row exactly like a voice snapshot: their
-- platform row, else the row already carrying the suggested wallet, else a new
-- row. A suggested wallet is used only on the community's network and when it
-- is not on the call yet.
create function public.record_call_sessions(p_call_id uuid, p_provider text, p_sessions jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  c public.calls;
  v_network int;
  v_attendee uuid;
  v_wallet text;
  v_new int := 0;
  v_sessions int := 0;
  r record;
begin
  if p_provider not in ('zoom', 'meet') then
    raise exception 'Sessions are recorded for zoom and meet' using errcode = '23514';
  end if;
  select * into c from calls where id = p_call_id for update;
  if not found then raise exception 'Call not found' using errcode = 'P0002'; end if;
  select network into v_network from communities where id = c.community_id;

  for r in
    select x.key, coalesce(nullif(trim(x.name), ''), 'Participant') as name, nullif(x.wallet, '') as wallet,
      x.joined, x."left", x.source
    from jsonb_to_recordset(coalesce(p_sessions, '[]'::jsonb))
      as x(key text, name text, wallet text, joined timestamptz, "left" timestamptz, source text)
    where x.key is not null and x.key <> ''
    order by x.joined nulls last
  loop
    v_attendee := null;
    v_wallet := case when r.wallet is not null and (r.wallet like 'addr_test%') = (v_network = 0)
      and exists (select 1 from contributors where wallet_address = r.wallet) then r.wallet end;

    select a.id into v_attendee from call_attendees a
      where a.call_id = c.id and a.provider = p_provider and a.external_id = r.key;
    if v_attendee is null and v_wallet is not null then
      select a.id into v_attendee from call_attendees a where a.call_id = c.id and a.wallet_address = v_wallet;
    end if;
    if v_attendee is null then
      -- A leave event for someone never seen joining says nothing usable.
      continue when r.joined is null;
      insert into call_attendees (call_id, provider, external_id, display_name, wallet_address)
        values (c.id, p_provider, r.key, r.name, v_wallet) returning id into v_attendee;
      v_new := v_new + 1;
    end if;

    if r.joined is not null then
      insert into call_attendee_sessions (attendee_id, joined_at, left_at, source_key)
        values (v_attendee, r.joined, case when r."left" >= r.joined then r."left" end, r.source)
        on conflict (source_key) do update
          set left_at = coalesce(excluded.left_at, call_attendee_sessions.left_at);
      v_sessions := v_sessions + 1;
    elsif r."left" is not null then
      update call_attendee_sessions s set left_at = r."left"
        where s.id = (select o.id from call_attendee_sessions o
          where o.attendee_id = v_attendee and o.left_at is null and o.joined_at <= r."left"
          order by o.joined_at desc limit 1);
    end if;
  end loop;

  perform recompute_call_minutes(c.id);
  return jsonb_build_object('sessions', v_sessions, 'added', v_new);
end $$;

revoke all on function public.recompute_call_minutes(uuid) from public, authenticated, anon;
revoke all on function public.record_call_sessions(uuid, text, jsonb) from public, authenticated, anon;
grant execute on function public.recompute_call_minutes(uuid) to service_role;
grant execute on function public.record_call_sessions(uuid, text, jsonb) to service_role;
