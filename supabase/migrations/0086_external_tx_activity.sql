-- Classify external_txs from on-chain certificates / metadata (stake,
-- CIP-0146 registration, anchors, DRep, votes) so the Treasury list can
-- title them instead of falling back to "Outgoing transfer" /
-- "Built outside Treasury Guild". Written by pollTreasury and backfilled
-- by syncTreasury; jsonb shape is ExternalActivity in src/lib/externalActivity.ts.

alter table public.external_txs
  add column if not exists activity jsonb;

comment on column public.external_txs.activity is
  'Classifier result for a spend with no app transactions row: stake / registration / anchor / drep / vote details, or null when unrecognized.';
