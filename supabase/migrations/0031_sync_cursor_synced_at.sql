-- When a treasury address was last polled against the chain (pollTreasury),
-- whether or not anything new arrived. The Treasury and Incoming pages call
-- POST /api/treasury/sync on visit; the route claims treasuries whose stamp is
-- older than two minutes with one atomic update (so concurrent visitors never
-- poll the same treasury twice) and polls only those. The 15-minute cron keeps
-- polling every treasury regardless. Service-role only like the rest of the
-- table: no read policy.

alter table treasury_sync_cursors add column synced_at timestamptz;
