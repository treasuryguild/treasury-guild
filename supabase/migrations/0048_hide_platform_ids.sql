-- Platform account ids stay out of member-readable columns (as 0039 did for
-- call_attendees.external_id), which the privacy policy promises:
--
-- * call_attendee_sessions.source_key carries the Zoom user id of a signed-in
--   participant (`zoom:rp:<user id>:<joined>`), and Meet session names.
-- * call_integrations.external_account_id is the Discord server id, the Zoom
--   account id or the Google host's OpenID sub.
--
-- Members keep reading presence and which platforms are connected; only
-- capture code (service role) reads and writes these columns.

revoke select on public.call_attendee_sessions from authenticated;
grant select (id, attendee_id, joined_at, left_at) on public.call_attendee_sessions to authenticated;

revoke select on public.call_integrations from authenticated;
grant select (id, community_id, provider, label, created_by, created_at) on public.call_integrations to authenticated;
