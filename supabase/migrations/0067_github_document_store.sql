-- GitHub as a second document store for frozen tally publications (beside
-- IPFS). A community that publishes to GitHub names one archive repository
-- on its App installation; the locator is `{repoId}/{blobSha}` (fits the
-- 64-byte metadatum cap). Turning the store on or changing the archive repo
-- stamps document_store_since so only new freezes go there.

-- Widen the store name checks.
alter table public.proposal_document_copies
  drop constraint proposal_document_copies_store_check;
alter table public.proposal_document_copies
  add constraint proposal_document_copies_store_check
  check (store in ('ipfs', 'github'));

alter table public.governance_community_settings
  drop constraint governance_community_settings_document_store_check;
alter table public.governance_community_settings
  add constraint governance_community_settings_document_store_check
  check (document_store in ('ipfs', 'github'));

alter table public.governance_community_settings
  add column document_archive_repo_id bigint,
  add column document_archive_full_name text;

alter table public.governance_community_settings
  add constraint governance_community_settings_archive_check check (
    (document_store = 'github'
      and document_archive_repo_id is not null
      and document_archive_full_name is not null
      and char_length(document_archive_full_name) between 3 and 200)
    or (document_store is distinct from 'github'
      and document_archive_repo_id is null
      and document_archive_full_name is null)
  );

-- Upsert publication store + spend check; for github, the archive repo too.
-- Bumps document_store_since when the store name or archive repo changes.
create or replace function public.save_governance_community_settings(
  p_community_id uuid, p_settings jsonb, p_actor text
) returns void language plpgsql security invoker set search_path = public as $$
declare
  v_before public.governance_community_settings;
  v_store text := nullif(p_settings->>'document_store', '');
  v_check text := coalesce(nullif(p_settings->>'spend_check', ''), 'warn');
  v_repo bigint := nullif(p_settings->>'document_archive_repo_id', '')::bigint;
  v_name text := nullif(p_settings->>'document_archive_full_name', '');
  v_since timestamptz;
begin
  if v_store is distinct from 'github' then
    v_repo := null;
    v_name := null;
  end if;
  select * into v_before from governance_community_settings where community_id = p_community_id for update;
  -- clock_timestamp so a repo change in the same transaction still bumps since
  -- (now() is fixed for the whole transaction).
  v_since := case when v_store is null then null
    when v_before.document_store is distinct from v_store then clock_timestamp()
    when v_store = 'github' and v_before.document_archive_repo_id is distinct from v_repo then clock_timestamp()
    else v_before.document_store_since end;
  insert into governance_community_settings(
    community_id, document_store, document_store_since, document_archive_repo_id, document_archive_full_name,
    spend_check, updated_by, updated_at
  ) values (
    p_community_id, v_store, v_since, v_repo, v_name, v_check, p_actor, now()
  )
  on conflict (community_id) do update set
    document_store = excluded.document_store,
    document_store_since = excluded.document_store_since,
    document_archive_repo_id = excluded.document_archive_repo_id,
    document_archive_full_name = excluded.document_archive_full_name,
    spend_check = excluded.spend_check,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
  insert into governance_setting_changes(community_id, kind, actor, before_value, after_value)
    select p_community_id, 'community', p_actor,
      case when v_before.community_id is null then null else to_jsonb(v_before) end, to_jsonb(g)
    from governance_community_settings g where g.community_id = p_community_id;
end $$;
