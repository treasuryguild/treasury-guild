-- Linked Google Meet meetings. Meet pushes nothing, so where a Zoom join
-- creates the call of a linked meeting, the calls-sync cron finds a linked
-- Meet code's new conference and creates the call itself
-- (src/lib/calls/meetCapture.ts). calls.external_instance then holds the
-- conference record's name ("conferenceRecords/<id>"): a code is reused by
-- every occurrence, the record is the occurrence. The value is the call's
-- platform ('meet'), which a created call copies; the connected account stays
-- call_integrations.provider = 'google'.

alter table public.call_meeting_links
  drop constraint call_meeting_links_provider_check,
  add constraint call_meeting_links_provider_check check (provider in ('zoom', 'meet'));
