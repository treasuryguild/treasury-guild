-- Zoom webhook deliveries already handled. verifyZoomSignature accepts a
-- signed request for five minutes either side of its timestamp, so without
-- this a captured request could be sent again: a replayed app_deauthorized
-- would drop a connection an admin just re-made, a replayed join would
-- re-create a call a manager just deleted. A replay is byte-identical, so its
-- x-zm-signature identifies it; Zoom's own retries carry a new timestamp and
-- therefore a new signature, and still go through.
--
-- Only sha256(x-zm-signature) is kept: a MAC under the app's secret, which
-- says nothing about the event or anyone in it (payloads are never stored).
-- Rows are purged after ten minutes by the calls-sync sweep.
create table public.zoom_webhook_deliveries (
  signature_hash text primary key,
  received_at timestamptz not null default now()
);
create index zoom_webhook_deliveries_received_idx on public.zoom_webhook_deliveries(received_at);
alter table public.zoom_webhook_deliveries enable row level security;
revoke all on public.zoom_webhook_deliveries from anon, authenticated, service_role;
grant select, insert, delete on public.zoom_webhook_deliveries to service_role;
