-- Recurring workgroup budgets and richer incoming-transaction review.

create table workgroup_budgets (
  id uuid primary key default gen_random_uuid(),
  workgroup_id uuid not null references workgroups(id) on delete cascade,
  cadence text not null check (cadence in ('monthly', 'quarterly')),
  unit text not null default 'lovelace',
  amount bigint not null check (amount > 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workgroup_id, unit)
);

create index workgroup_budgets_workgroup_idx on workgroup_budgets(workgroup_id);

alter table workgroup_budgets enable row level security;

create policy workgroup_budgets_read on workgroup_budgets
  for select using (public.is_member(public.workgroup_community(workgroup_id)));

-- Writes go through the budget API, which checks admin/lead scope before using
-- the service role. Keeping browser writes disabled avoids editable ownership
-- fields and makes that authorization rule the only write path.

alter table incoming_txs
  add column incoming_type text not null default 'unclassified'
    check (incoming_type in ('unclassified', 'refund', 'contribution', 'revenue', 'transfer', 'other')),
  add column requires_reconciliation boolean not null default true,
  add column note text;
