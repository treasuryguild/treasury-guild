-- SDK treasury staking and Cardano DRep/voting: role-3 DRep key hashes on
-- base signers, stake/drep/vote transaction kinds, and a typed governance
-- action payload so the signing page can describe the certificate/vote.

alter table public.treasury_signers
  add column if not exists drep_key_hash text;

alter table public.transactions
  add column if not exists governance_action jsonb;

alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check
  check (kind in ('payout', 'mint', 'payment', 'anchor', 'stake', 'drep', 'vote'));
