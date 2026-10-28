-- Discord reminders for on-chain proposal anchors that sit due too long, and
-- a heads-up before the closed step's copy-grace window ends. Stamps so each
-- (proposal, step, kind) posts once per due episode (due_since). Service role
-- only — never member-readable personal data (proposal ids and steps only).

create table public.proposal_anchor_alerts (
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  step text not null check (step in ('proposed', 'opened', 'closed')),
  kind text not null check (kind in ('stale', 'copy_grace')),
  due_since timestamptz not null,
  alerted_at timestamptz not null default now(),
  primary key (proposal_id, step, kind)
);

comment on table public.proposal_anchor_alerts is
  'Discord stamp for anchor reminders: one row per (proposal, step, kind) for the current due_since episode.';

alter table public.proposal_anchor_alerts enable row level security;

revoke all on public.proposal_anchor_alerts from anon, authenticated, service_role;
grant select, insert, update, delete on public.proposal_anchor_alerts to service_role;
