-- Multi-asset payouts: community asset registry, per-unit payout rows, and
-- token-aware reconciliation columns.

-- Maps a GitHub Project number-field name (doubles as the display ticker) to
-- an on-chain unit. ADA is built into the app (lovelace, 6 decimals) and is
-- deliberately not registrable here.
create table community_assets (
  community_id uuid not null references communities(id) on delete cascade,
  field_name text not null check (char_length(field_name) between 1 and 32),
  unit text not null check (unit ~ '^[0-9a-f]{56,120}$'),
  decimals int not null default 0 check (decimals between 0 and 12),
  primary key (community_id, field_name),
  check (lower(field_name) <> 'ada')
);

alter table community_assets enable row level security;
create policy community_assets_read on community_assets
  for select using (public.is_member(community_id));
-- writes go through service-role API routes only

-- payouts: one row per (transaction, task, unit)
drop view contributor_balances;

alter table payouts rename column amount_lovelace to amount;
alter table payouts add column unit text not null default 'lovelace';
alter table payouts drop constraint payouts_transaction_id_task_id_key;
alter table payouts add unique (transaction_id, task_id, unit);

alter table reconciliations rename column amount_lovelace to amount;
alter table reconciliations add column unit text not null default 'lovelace';

-- Token amounts riding on incoming (refund) txs: {"<unit>": "<quantity>"}
alter table incoming_txs add column assets jsonb;

-- Net "effective received" per contributor and unit
create view contributor_balances as
select
  p.contributor_wallet,
  p.unit,
  coalesce(sum(p.amount) filter (where p.status in ('confirmed', 'written_back', 'adjusted')), 0)
    - coalesce((
        select sum(r.amount)
        from reconciliations r
        join payouts rp on rp.id = r.payout_id
        where rp.contributor_wallet = p.contributor_wallet
          and rp.unit = p.unit
          and r.unit = p.unit
      ), 0) as net_amount,
  count(*) filter (where p.status in ('confirmed', 'written_back', 'adjusted')) as paid_count
from payouts p
group by p.contributor_wallet, p.unit;
