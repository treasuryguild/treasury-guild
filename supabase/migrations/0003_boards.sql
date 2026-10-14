-- Workgroups (projects), board columns, unified tasks (native + github)

create table workgroups (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities(id) on delete cascade,
  name text not null,
  description text,
  kind text not null default 'native' check (kind in ('native', 'github')),
  created_at timestamptz not null default now()
);

create table board_columns (
  id uuid primary key default gen_random_uuid(),
  workgroup_id uuid not null references workgroups(id) on delete cascade,
  name text not null,
  position int not null,
  -- native boards: moving a task into this column marks it payable ("audited")
  marks_payable boolean not null default false
);

create type task_pay_state as enum ('none', 'payable', 'queued', 'paid', 'reconciled');

create table tasks (
  id uuid primary key default gen_random_uuid(),
  workgroup_id uuid not null references workgroups(id) on delete cascade,
  source text not null default 'native' check (source in ('native', 'github')),
  title text not null,
  body text,
  column_id uuid references board_columns(id) on delete set null,
  assignee_wallet text references contributors(wallet_address),
  bounty_lovelace bigint check (bounty_lovelace is null or bounty_lovelace > 0),
  pay_state task_pay_state not null default 'none',
  audited boolean not null default false,
  -- github mirror columns (null for native tasks)
  gh_repo_id bigint,
  gh_issue_number int,
  gh_node_id text,
  gh_project_item_node_id text,
  gh_status text,
  gh_labels jsonb,
  gh_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index tasks_gh_uq on tasks(gh_repo_id, gh_issue_number) where source = 'github';
create index tasks_workgroup_idx on tasks(workgroup_id);
create index tasks_pay_state_idx on tasks(pay_state) where pay_state = 'payable';
