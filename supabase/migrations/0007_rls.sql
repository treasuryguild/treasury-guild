-- RLS helpers + policies.
-- The wallet claim comes from our custom JWT (wallet = bech32 address).
-- NEVER use auth.uid() here: sub is a bech32 address, not a UUID.

create function public.jwt_wallet() returns text
language sql stable
as $$ select nullif(auth.jwt() ->> 'wallet', '') $$;

create function public.is_member(cid uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from community_members
    where community_id = cid and wallet_address = public.jwt_wallet()
  )
$$;

create function public.is_admin(cid uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from community_members
    where community_id = cid
      and wallet_address = public.jwt_wallet()
      and role in ('owner', 'admin')
  )
$$;

create function public.workgroup_community(wid uuid) returns uuid
language sql stable security definer set search_path = public
as $$ select community_id from workgroups where id = wid $$;

-- Enable RLS everywhere
alter table contributors enable row level security;
alter table communities enable row level security;
alter table community_members enable row level security;
alter table auth_nonces enable row level security;
alter table treasuries enable row level security;
alter table treasury_signers enable row level security;
alter table transactions enable row level security;
alter table workgroups enable row level security;
alter table board_columns enable row level security;
alter table tasks enable row level security;
alter table github_installations enable row level security;
alter table github_repos enable row level security;
alter table github_project_links enable row level security;
alter table webhook_events enable row level security;
alter table payouts enable row level security;
alter table incoming_txs enable row level security;
alter table reconciliations enable row level security;
alter table treasury_sync_cursors enable row level security;

-- contributors: anyone authenticated can read; a wallet manages only its own row
create policy contributors_read on contributors for select using (true);
create policy contributors_insert_self on contributors
  for insert with check (wallet_address = public.jwt_wallet());
create policy contributors_update_self on contributors
  for update using (wallet_address = public.jwt_wallet());

-- communities: public read (discovery by slug); creation via server route (service role)
create policy communities_read on communities for select using (true);

-- community_members: members can see the roster
create policy members_read on community_members
  for select using (public.is_member(community_id));

-- auth_nonces: service-role only (no policies)

-- treasuries / signers / transactions: member-read; all writes via service-role routes
create policy treasuries_read on treasuries
  for select using (public.is_member(community_id));
create policy treasury_signers_read on treasury_signers
  for select using (exists (
    select 1 from treasuries t
    where t.id = treasury_id and public.is_member(t.community_id)
  ));
create policy transactions_read on transactions
  for select using (exists (
    select 1 from treasuries t
    where t.id = treasury_id and public.is_member(t.community_id)
  ));

-- workgroups / columns / tasks: member-read, member-write (native board editing)
create policy workgroups_read on workgroups
  for select using (public.is_member(community_id));
create policy workgroups_write on workgroups
  for all using (public.is_admin(community_id)) with check (public.is_admin(community_id));

create policy board_columns_read on board_columns
  for select using (public.is_member(public.workgroup_community(workgroup_id)));
create policy board_columns_write on board_columns
  for all using (public.is_admin(public.workgroup_community(workgroup_id)))
  with check (public.is_admin(public.workgroup_community(workgroup_id)));

create policy tasks_read on tasks
  for select using (public.is_member(public.workgroup_community(workgroup_id)));
create policy tasks_insert on tasks
  for insert with check (
    source = 'native' and public.is_member(public.workgroup_community(workgroup_id))
  );
create policy tasks_update on tasks
  for update using (public.is_member(public.workgroup_community(workgroup_id)))
  with check (public.is_member(public.workgroup_community(workgroup_id)));

-- github link tables: member-read; writes via service-role routes
create policy gh_installations_read on github_installations
  for select using (public.is_member(community_id));
create policy gh_repos_read on github_repos
  for select using (exists (
    select 1 from github_installations gi
    where gi.installation_id = github_repos.installation_id
      and public.is_member(gi.community_id)
  ));
create policy gh_project_links_read on github_project_links
  for select using (public.is_member(public.workgroup_community(workgroup_id)));

-- webhook_events: service-role only (no policies)

-- payouts / reconciliation: member-read via treasury->community; writes via service role
create policy payouts_read on payouts
  for select using (exists (
    select 1 from transactions tx
    join treasuries t on t.id = tx.treasury_id
    where tx.id = transaction_id and public.is_member(t.community_id)
  ));
create policy incoming_txs_read on incoming_txs
  for select using (exists (
    select 1 from treasuries t
    where t.id = treasury_id and public.is_member(t.community_id)
  ));
create policy reconciliations_read on reconciliations
  for select using (exists (
    select 1 from incoming_txs itx
    join treasuries t on t.id = itx.treasury_id
    where itx.tx_hash = incoming_tx_hash and public.is_member(t.community_id)
  ));

-- Lock the RPC down to service role: signature merging is validated server-side.
revoke execute on function add_signature(uuid, text, text, int) from public, anon, authenticated;
