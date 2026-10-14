-- Zoom join / leave events that arrive before their call exists. Hosts open
-- the meeting first and create the rewarded call afterwards, so an event of a
-- connected host account that matches no call is parked here instead of being
-- dropped, and replayed into the call once one names that meeting
-- (src/lib/calls/zoomCapture.ts). Rows hold what a presence session holds (a
-- participant key, the name shown, the times), never the payload or an email,
-- and the calls-sync cron deletes whatever nobody claimed within a day.
--
-- Service-role only (no policies): the key may be a Zoom user id.

create table public.call_pending_sessions (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('zoom')),
  -- call_integrations.external_account_id of the sending host account.
  external_account_id text not null,
  -- What calls.external_ref will name: the meeting id.
  meeting_ref text not null,
  participant_key text not null,
  display_name text not null,
  -- A join event carries joined_at and a source_key; a leave event only left_at.
  joined_at timestamptz,
  left_at timestamptz,
  source_key text unique,
  received_at timestamptz not null default now(),
  check (joined_at is not null or left_at is not null)
);
create index call_pending_sessions_meeting_idx
  on public.call_pending_sessions (provider, external_account_id, meeting_ref);
create index call_pending_sessions_received_idx on public.call_pending_sessions (received_at);

alter table public.call_pending_sessions enable row level security;
-- service-role only (no policies)
revoke all on public.call_pending_sessions from anon, authenticated, service_role;
grant select, insert, update, delete on public.call_pending_sessions to service_role;
