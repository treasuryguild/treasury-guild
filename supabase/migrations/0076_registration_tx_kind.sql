-- CIP-0146 (label 1854) on-chain treasury registration: a self-spend that
-- carries registration metadata so co-signers can discover and import the
-- wallet. Same pending-tx / sign / submit flow as anchors; no payout rows.

alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check
  check (kind in ('payout', 'mint', 'payment', 'anchor', 'stake', 'drep', 'vote', 'registration'));
