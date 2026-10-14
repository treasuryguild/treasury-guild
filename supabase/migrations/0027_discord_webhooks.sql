-- Discord payout notifications: one optional incoming-webhook URL per treasury.
-- The URL is a bearer secret (anyone holding it can post to the channel), so
-- it lives in its own table with no RLS policies: service-role routes only.
-- Members read treasuries through RLS, which is why this is not a column there.

create table treasury_discord_webhooks (
  treasury_id uuid primary key references treasuries(id) on delete cascade,
  url text not null,
  created_by text not null, -- wallet of the admin who connected it
  created_at timestamptz not null default now(),
  last_posted_at timestamptz,
  last_error text
);

alter table treasury_discord_webhooks enable row level security;
-- service-role only (no policies)

-- Set by the reconcile cron once the payout summary has been posted (or the
-- webhook turned out to be dead). NULL = still to announce.
alter table transactions add column discord_notified_at timestamptz;

-- Never announce history: everything already confirmed counts as notified.
update transactions set discord_notified_at = now() where state = 2; -- TxState.Confirmed
