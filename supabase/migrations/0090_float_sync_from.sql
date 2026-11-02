-- Optional start-after point when adopting an existing float address: poll
-- only blocks after sync_from_block (seeded into float_sync_cursors).

alter table public.float_wallets
  add column sync_from_tx_hash text
    check (sync_from_tx_hash is null or sync_from_tx_hash ~ '^[0-9a-f]{64}$'),
  add column sync_from_block bigint
    check (sync_from_block is null or sync_from_block >= 0);

alter table public.float_wallets
  add constraint float_wallets_sync_from_pair_chk
  check (
    (sync_from_tx_hash is null and sync_from_block is null)
    or (sync_from_tx_hash is not null and sync_from_block is not null)
  );

comment on column public.float_wallets.sync_from_tx_hash is
  'Cardano tx at/before which history is ignored when monitoring began.';
comment on column public.float_wallets.sync_from_block is
  'Block height seeded into float_sync_cursors at create (Koios after-height).';
