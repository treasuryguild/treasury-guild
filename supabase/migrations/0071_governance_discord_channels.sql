-- Governance Discord: replace the pasted incoming webhook with a channel on
-- the community's connected Discord server (call_integrations). The bot posts
-- proposal milestones, outside-spend alerts and anchor reminders there, and
-- opens one discussion thread/forum post per proposal that has a discussion
-- period. Thread ids live on proposals and are not part of content_hash.

drop table if exists public.governance_discord_webhooks;

create table public.governance_discord_channels (
  community_id uuid primary key references public.communities(id) on delete cascade,
  channel_id text not null,
  -- Discord channel type: 0 text, 5 announcement, 15 forum.
  channel_type int not null check (channel_type in (0, 5, 15)),
  created_by text not null,
  created_at timestamptz not null default now(),
  last_posted_at timestamptz,
  last_error text
);
alter table public.governance_discord_channels enable row level security;
revoke all on public.governance_discord_channels from anon, authenticated, service_role;
grant select, insert, update, delete on public.governance_discord_channels to service_role;

alter table public.proposals
  add column discord_thread_id text,
  add column discord_discussion_url text
    check (
      discord_discussion_url is null
      or (char_length(discord_discussion_url) <= 500 and discord_discussion_url ~* '^https?://\S+$')
    );
