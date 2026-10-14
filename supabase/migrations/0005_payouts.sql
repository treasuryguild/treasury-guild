-- Per-contributor payout rows linking tasks to multisig transactions

create table payouts (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  task_id uuid not null references tasks(id),
  contributor_wallet text not null,
  amount_lovelace bigint not null check (amount_lovelace > 0),
  status text not null default 'pending'
    check (status in ('pending', 'submitted', 'confirmed', 'written_back', 'adjusted')),
  created_at timestamptz not null default now(),
  unique (transaction_id, task_id)
);

create index payouts_wallet_idx on payouts(contributor_wallet);
create index payouts_status_idx on payouts(status);
