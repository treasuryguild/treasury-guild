-- Roles: per-workgroup leads + signer->admin promotion; GitHub account linking.

-- 1. Workgroup leads: admins assign wallets as leads of specific workgroups.
create table workgroup_leads (
  workgroup_id uuid not null references workgroups(id) on delete cascade,
  wallet_address text not null references contributors(wallet_address),
  created_at timestamptz not null default now(),
  primary key (workgroup_id, wallet_address)
);
alter table workgroup_leads enable row level security;

-- member-read; writes via service-role routes only (admin-managed)
create policy workgroup_leads_read on workgroup_leads
  for select using (public.is_member(public.workgroup_community(workgroup_id)));

-- 2. Helpers (security definer bypasses RLS on the tables they read)
create function public.is_lead(wid uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from workgroup_leads
    where workgroup_id = wid and wallet_address = public.jwt_wallet()
  )
$$;

create function public.can_manage_workgroup(wid uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_admin(public.workgroup_community(wid)) or public.is_lead(wid)
$$;

-- 3. Task and board-column writes: admins or workgroup leads only.
-- Members keep read access; edits by non-managers previously allowed via
-- is_member are now denied.
drop policy tasks_insert on tasks;
drop policy tasks_update on tasks;
create policy tasks_insert on tasks
  for insert with check (
    source = 'native' and public.can_manage_workgroup(workgroup_id)
  );
create policy tasks_update on tasks
  for update using (public.can_manage_workgroup(workgroup_id))
  with check (public.can_manage_workgroup(workgroup_id));

drop policy board_columns_write on board_columns;
create policy board_columns_write on board_columns
  for all using (public.can_manage_workgroup(workgroup_id))
  with check (public.can_manage_workgroup(workgroup_id));

-- 4. Treasury signers are community admins. The 'signer' role value is legacy:
-- promote existing rows; new signer upserts write 'admin' (treasury route).
update community_members set role = 'admin' where role = 'signer';

-- 5. GitHub identity: one GitHub account maps to at most one wallet.
-- github_user_id stored for rename resilience (matching is by login today).
alter table contributors add column github_user_id bigint;
create unique index contributors_github_username_uq
  on contributors (lower(github_username)) where github_username is not null;
create unique index contributors_github_user_id_uq
  on contributors (github_user_id) where github_user_id is not null;

-- 6. github_username / github_user_id must not be self-assertable: the OAuth
-- callback route (service role) is the only writer. contributors_*_self RLS
-- policies are row-level, so restrict columns via grants.
revoke insert, update on contributors from authenticated, anon;
grant insert (wallet_address, handle) on contributors to authenticated;
grant update (handle) on contributors to authenticated;

-- 7. Mirror of the GitHub issue assignee login; assignee_wallet is auto-filled
-- from it only while null (manual assignment always wins).
alter table tasks add column gh_assignee_login text;
create index tasks_gh_assignee_idx on tasks (lower(gh_assignee_login))
  where gh_assignee_login is not null and assignee_wallet is null;
