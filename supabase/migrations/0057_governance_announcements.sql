-- Discord announcements of proposals: one optional incoming-webhook URL per
-- community (a bearer secret, like treasury_discord_webhooks: service-role
-- only, never returned to the browser). The reconcile sweep posts each
-- proposal's milestones in order (up for discussion, voting open, a day
-- left, the result) and records the last one posted in discord_milestone, so
-- a milestone is posted once and a skipped one is never posted late.

create table public.governance_discord_webhooks (
  community_id uuid primary key references public.communities(id) on delete cascade,
  url text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  last_posted_at timestamptz,
  last_error text
);
alter table public.governance_discord_webhooks enable row level security;
-- No policies: service-role routes only.
revoke all on public.governance_discord_webhooks from anon, authenticated, service_role;
grant select, insert, update, delete on public.governance_discord_webhooks to service_role;

alter table public.proposals add column discord_milestone text
  check (discord_milestone in ('discussion', 'voting', 'reminder', 'closed'));
