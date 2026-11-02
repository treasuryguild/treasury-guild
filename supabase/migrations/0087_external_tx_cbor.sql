-- Cache confirmed transaction bytes on external_txs so the on-chain details
-- page does not re-fetch Koios CBOR on every visit (paired with persisted
-- poolTicker / dRepName on activity from the enrich helper).

alter table public.external_txs
  add column if not exists tx_cbor text;

comment on column public.external_txs.tx_cbor is
  'Trusted on-chain transaction bytes (hash-checked); null until the details page or a later writer caches them.';
