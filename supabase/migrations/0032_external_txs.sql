-- Outgoing transactions seen at a treasury address that the app did not build
-- (or no longer has a `transactions` row for): another tool spent from the
-- multisig, or the local database lost its record. pollTreasury records them
-- so the Treasury page can show the wallet's real history; the payout
-- metadata (label 190001) is kept as returned by Koios for display. Rows are
-- written only by the service role and read by community members, like
-- incoming_txs.

create table external_txs (
  tx_hash text primary key,
  treasury_id uuid not null references treasuries(id) on delete cascade,
  block_height bigint not null,
  block_time timestamptz not null,
  fee_lovelace bigint not null,
  -- lovelace / tokens paid to addresses other than the treasury (change excluded)
  amount_lovelace bigint not null,
  assets jsonb,
  to_addresses text[] not null default '{}',
  payout_meta jsonb,
  created_at timestamptz not null default now()
);

create index external_txs_treasury_time_idx on external_txs(treasury_id, block_time desc);

alter table external_txs enable row level security;
create policy external_txs_read on external_txs
  for select using (exists (
    select 1 from treasuries t
    where t.id = treasury_id and public.is_member(t.community_id)
  ));

-- Backfill: walk every treasury's history once more on the next poll.
-- Incoming inserts and confirmations are idempotent; external rows are new.
update treasury_sync_cursors set last_block_height = 0;
