-- Payout Discord: a treasury may announce via a bot channel on the community's
-- connected Discord server (call_integrations) or via a pasted incoming webhook
-- URL. Exactly one of url / channel_id is set (XOR). Channel mode is text or
-- announcement only — payouts are one-shot embeds, not forum threads.

alter table public.treasury_discord_webhooks rename to treasury_discord_destinations;

alter table public.treasury_discord_destinations
  alter column url drop not null,
  add column channel_id text,
  add column channel_type int;

alter table public.treasury_discord_destinations
  add constraint treasury_discord_destinations_channel_type_chk
    check (channel_type is null or channel_type in (0, 5)),
  add constraint treasury_discord_destinations_mode_chk
    check (
      (url is not null and channel_id is null and channel_type is null)
      or
      (url is null and channel_id is not null and channel_type is not null)
    );

revoke all on public.treasury_discord_destinations from anon, authenticated, service_role;
grant select, insert, update, delete on public.treasury_discord_destinations to service_role;
