-- Incoming (refund) txs to treasuries, reconciliation ledger, sync cursors

create table incoming_txs (
  tx_hash text primary key,
  treasury_id uuid not null references treasuries(id) on delete cascade,
  from_addresses text[] not null default '{}',
  amount_lovelace bigint not null,
  block_time timestamptz,
  matched boolean not null default false
);

create index incoming_txs_treasury_idx on incoming_txs(treasury_id) where not matched;

create table reconciliations (
  id uuid primary key default gen_random_uuid(),
  incoming_tx_hash text not null references incoming_txs(tx_hash),
  payout_id uuid references payouts(id), -- null = unmatched annotation
  amount_lovelace bigint not null,
  note text,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table treasury_sync_cursors (
  treasury_id uuid primary key references treasuries(id) on delete cascade,
  last_block_height bigint not null default 0
);

-- Net "effective received" per contributor: confirmed payouts minus reconciled refunds
create view contributor_balances as
select
  p.contributor_wallet,
  coalesce(sum(p.amount_lovelace) filter (where p.status in ('confirmed', 'written_back', 'adjusted')), 0)
    - coalesce((
        select sum(r.amount_lovelace)
        from reconciliations r
        join payouts rp on rp.id = r.payout_id
        where rp.contributor_wallet = p.contributor_wallet
      ), 0) as net_lovelace,
  count(*) filter (where p.status in ('confirmed', 'written_back', 'adjusted')) as paid_count
from payouts p
group by p.contributor_wallet;
