-- GitHub App installations, repo/project links, webhook idempotency log

create table github_installations (
  installation_id bigint primary key,
  community_id uuid not null references communities(id) on delete cascade,
  account_login text not null,
  account_type text,
  created_at timestamptz not null default now()
);

create table github_repos (
  id bigint primary key, -- GitHub repo databaseId
  installation_id bigint not null references github_installations(installation_id) on delete cascade,
  full_name text not null,
  workgroup_id uuid references workgroups(id) on delete set null,
  payable_label text not null default 'audited',
  sync_cursor timestamptz
);

create table github_project_links (
  project_node_id text primary key, -- ProjectV2 node id
  installation_id bigint not null references github_installations(installation_id) on delete cascade,
  workgroup_id uuid not null references workgroups(id) on delete cascade,
  payable_status text not null default 'Audited'
);

create table webhook_events (
  delivery_id text primary key, -- X-GitHub-Delivery header
  event text not null,
  action text,
  payload jsonb,
  processed_at timestamptz,
  error text,
  received_at timestamptz not null default now()
);

create index webhook_events_error_idx on webhook_events(received_at) where error is not null;
