-- Groundwork for decisions that are evident on-chain (docs/onchain-anchoring-
-- estimate.md, phases 0 to 2):
--
--   * one pending transaction per treasury is now a unique index, not only a
--     read-then-insert check in the build routes (two builds could race past
--     it), and 'anchor' joins the transaction kinds ahead of the anchor route;
--   * a proposal that reached voting gets one frozen tally document (the exact
--     canonical JSON that was hashed) once it is final, written once by
--     freeze_proposal_tally; copies published to an outside store (IPFS today)
--     are recorded per document, so old copies keep resolving after a switch;
--   * the community-level governance settings: where documents are published
--     (off by default) and whether a spend that fails the budget check is
--     warned about or refused;
--   * back-links from what a proposal created or set: tasks.proposal_id (set
--     by apply_task_proposal) and proposal_id on budget setups and plans,
--     stamped by a trigger from treasury_guild.proposal_apply, so a payout or
--     payment can cite the decisions behind it;
--   * transactions.spend_problems keeps what the budget check found at build
--     time (warn mode) for the signers; external_txs.governance_alerted_at
--     records the one Discord alert for a spend built outside the app.

-- 1. One pending transaction per treasury ---------------------------------------

do $$
declare
  v_treasury uuid;
begin
  select treasury_id into v_treasury from public.transactions where state = 0
    group by treasury_id having count(*) > 1 limit 1;
  if v_treasury is not null then
    raise exception 'Treasury % has more than one pending transaction; resolve it before migrating', v_treasury;
  end if;
end $$;

create unique index transactions_one_pending_uq on public.transactions(treasury_id) where state = 0;

alter table public.transactions drop constraint transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check
  check (kind in ('payout', 'generic', 'mint', 'payment', 'anchor'));

-- What the budget check found when the transaction was built (warn mode);
-- [] when nothing was found or the check did not run.
alter table public.transactions add column spend_problems jsonb not null default '[]';

-- 2. Frozen tally documents -----------------------------------------------------

-- The document's exact bytes: canonical JSON of {hashAlgorithm, body, hash},
-- with `hash` the blake2b-256 of the canonical body. Its own table keeps the
-- proposals list light.
create table public.proposal_tally_documents (
  proposal_id uuid primary key references public.proposals(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  document text not null,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  frozen_at timestamptz not null default now()
);
create index proposal_tally_documents_community_idx on public.proposal_tally_documents(community_id, frozen_at);

-- Write-once: true when this call stored the document, false when one exists.
create function public.freeze_proposal_tally(p_proposal_id uuid, p_document text, p_hash text)
returns boolean language plpgsql security invoker set search_path = public as $$
declare
  p public.proposals;
  v_inserted boolean;
begin
  select * into p from proposals where id = p_proposal_id for update;
  if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
  if p.state in ('discussion', 'voting') then
    raise exception 'The proposal is not final yet' using errcode = '23514';
  end if;
  if p.voting_opened_at is null then
    raise exception 'The proposal never reached voting' using errcode = '23514';
  end if;
  insert into proposal_tally_documents(proposal_id, community_id, document, hash)
    values (p.id, p.community_id, p_document, p_hash)
    on conflict (proposal_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end $$;

-- One row per copy of a frozen document in an outside store. The locator is
-- what that store needs to find it (for IPFS, the bare CID). last_checked_at
-- is when the sweep last saw the copy resolve.
create table public.proposal_document_copies (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposal_tally_documents(proposal_id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  store text not null check (store in ('ipfs')),
  locator text not null check (char_length(locator) between 1 and 200),
  stored_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  unique (proposal_id, store)
);

-- 3. Community-level governance settings ----------------------------------------

-- A missing row means: no publication, and a failed budget check warns.
create table public.governance_community_settings (
  community_id uuid primary key references public.communities(id) on delete cascade,
  -- Where new frozen documents are published; null keeps them in the database only.
  document_store text check (document_store in ('ipfs')),
  -- When the current store was chosen: only documents frozen from then on go there.
  document_store_since timestamptz,
  spend_check text not null default 'warn' check (spend_check in ('warn', 'refuse')),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  check ((document_store is null) = (document_store_since is null))
);

-- Upsert {document_store, spend_check} and log the change with the per-kind
-- ones (kind 'community').
create function public.save_governance_community_settings(p_community_id uuid, p_settings jsonb, p_actor text)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_before public.governance_community_settings;
  v_store text := nullif(p_settings->>'document_store', '');
  v_check text := coalesce(nullif(p_settings->>'spend_check', ''), 'warn');
  v_since timestamptz;
begin
  select * into v_before from governance_community_settings where community_id = p_community_id for update;
  v_since := case when v_store is null then null
    when v_before.document_store is distinct from v_store then now()
    else v_before.document_store_since end;
  insert into governance_community_settings(community_id, document_store, document_store_since, spend_check, updated_by, updated_at)
    values (p_community_id, v_store, v_since, v_check, p_actor, now())
    on conflict (community_id) do update set document_store = excluded.document_store,
      document_store_since = excluded.document_store_since, spend_check = excluded.spend_check,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into governance_setting_changes(community_id, kind, actor, before_value, after_value)
    select p_community_id, 'community', p_actor,
      case when v_before.community_id is null then null else to_jsonb(v_before) end, to_jsonb(g)
    from governance_community_settings g where g.community_id = p_community_id;
end $$;

-- 4. Back-links from proposals ----------------------------------------------------

alter table public.tasks add column proposal_id uuid references public.proposals(id) on delete set null;
alter table public.budget_setups add column proposal_id uuid references public.proposals(id) on delete set null;
alter table public.budget_plans add column proposal_id uuid references public.proposals(id) on delete set null;

-- The applying proposal, from the setting execute_proposal sets; the dry run
-- ('check') and anything else that is not an id leave null.
create function public.stamp_budget_proposal() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_apply text := coalesce(current_setting('treasury_guild.proposal_apply', true), '');
begin
  new.proposal_id := case when v_apply ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then v_apply::uuid else null end;
  return new;
end $$;
create trigger budget_setups_proposal before insert or update on public.budget_setups
  for each row execute function public.stamp_budget_proposal();
create trigger budget_plans_proposal before insert or update on public.budget_plans
  for each row execute function public.stamp_budget_proposal();

-- As in 0056, with the task linked to its proposal.
create or replace function public.apply_task_proposal(p public.proposals) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_spec jsonb := p.payload->'task';
  w public.workgroups;
  v_column uuid;
  v_task uuid;
begin
  select * into w from workgroups where id = (v_spec->>'workgroupId')::uuid for update;
  if not found or w.community_id <> p.community_id then
    raise exception 'The workgroup of this task no longer exists' using errcode = '23514';
  end if;
  if w.archived_at is not null then
    raise exception 'Restore the workgroup % before adding the task', w.name using errcode = '23514';
  end if;
  if w.kind <> 'native' then
    raise exception 'Tasks are proposed only on app boards, and % is a GitHub board', w.name using errcode = '23514';
  end if;
  select id into v_column from board_columns
    where workgroup_id = w.id and not marks_payable and not marks_paid order by position limit 1;
  -- number and community_id come from assign_task_number; budget_month is stamped by build-payout.
  insert into tasks(workgroup_id, source, title, body, amounts, bounty_lovelace, pay_state, audited, column_id, proposal_id)
    values (w.id, 'native', p.title, nullif(p.body, ''), v_spec->'amounts',
      nullif(v_spec->>'bountyLovelace', '')::bigint, 'none', false, v_column, p.id)
    returning id into v_task;
  if coalesce((v_spec->>'assignSelf')::boolean, false) and exists (select 1 from community_members
      where community_id = p.community_id and wallet_address = p.proposer) then
    insert into task_assignees(task_id, source, wallet_address, position) values (v_task, 'manual', p.proposer, 0);
  end if;
  return jsonb_build_object('taskId', v_task, 'workgroupId', w.id);
end $$;

-- 5. Outside-spend alerts --------------------------------------------------------

-- When the sweep announced (or decided not to announce) the spend; rows from
-- before this migration are history and never announced.
alter table public.external_txs add column governance_alerted_at timestamptz;
update public.external_txs set governance_alerted_at = now();
create index external_txs_unalerted_idx on public.external_txs(treasury_id) where governance_alerted_at is null;

-- 6. Access ------------------------------------------------------------------------

alter table public.proposal_tally_documents enable row level security;
alter table public.proposal_document_copies enable row level security;
alter table public.governance_community_settings enable row level security;
create policy proposal_tally_documents_read on public.proposal_tally_documents for select
  using (public.is_member(community_id));
create policy proposal_document_copies_read on public.proposal_document_copies for select
  using (public.is_member(community_id));
create policy governance_community_settings_read on public.governance_community_settings for select
  using (public.is_member(community_id));

revoke all on public.proposal_tally_documents, public.proposal_document_copies, public.governance_community_settings
  from anon, authenticated, service_role;
grant select on public.proposal_tally_documents, public.proposal_document_copies, public.governance_community_settings
  to authenticated;
grant select, insert, update, delete on public.proposal_tally_documents, public.proposal_document_copies,
  public.governance_community_settings to service_role;

revoke all on function public.freeze_proposal_tally(uuid, text, text) from public, anon, authenticated;
revoke all on function public.save_governance_community_settings(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.freeze_proposal_tally(uuid, text, text) to service_role;
grant execute on function public.save_governance_community_settings(uuid, jsonb, text) to service_role;
