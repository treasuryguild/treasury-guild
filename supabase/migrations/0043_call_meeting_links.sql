-- Linked meetings: a community's recurring Zoom meeting (or personal room)
-- tied, once, to the workgroup that rewards it. When the connected host
-- account reports someone joining a linked meeting and no call covers it, the
-- call is created on the spot from the link (src/lib/calls/zoomCapture.ts), so
-- nobody has to list the call before the meeting; a manager reviews and
-- rewards it whenever they like. Meetings nobody linked stay parked
-- (migration 0042) and show up as "detected meetings" for managers to claim.

create table public.call_meeting_links (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  workgroup_id uuid not null references public.workgroups(id) on delete cascade,
  provider text not null check (provider in ('zoom')),
  -- What calls.external_ref names: the meeting id.
  meeting_ref text not null,
  -- The created calls' title, reward and threshold.
  title text not null check (length(trim(title)) > 0),
  amounts jsonb not null check (jsonb_typeof(amounts) = 'object' and amounts <> '{}'::jsonb),
  min_minutes int not null default 0 check (min_minutes >= 0),
  -- How long a created call runs until the meeting says otherwise.
  duration_minutes int not null default 60 check (duration_minutes between 1 and 1440),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (community_id, provider, meeting_ref)
);
create index call_meeting_links_ref_idx on public.call_meeting_links (provider, meeting_ref);

-- community_id follows the workgroup, which never changes (same rule as calls).
create trigger call_meeting_links_set_community before insert or update on public.call_meeting_links
  for each row execute function public.calls_set_community();

alter table public.call_meeting_links enable row level security;
create policy call_meeting_links_read on public.call_meeting_links for select
  using (public.is_member(community_id));
revoke all on public.call_meeting_links from anon, authenticated, service_role;
grant select on public.call_meeting_links to authenticated;
grant select, insert, update, delete on public.call_meeting_links to service_role;

-- A call created from a link remembers which occurrence of the meeting it is
-- (Zoom's meeting uuid): later events of that occurrence find it exactly, and
-- two first joins arriving together cannot create it twice.
alter table public.calls
  add column meeting_link_id uuid references public.call_meeting_links(id) on delete set null,
  add column external_instance text;
create unique index calls_external_instance_uq
  on public.calls (community_id, provider, external_instance) where external_instance is not null;

-- What the detected-meetings list shows about a parked event's meeting.
alter table public.call_pending_sessions
  add column meeting_instance text,
  add column topic text;
