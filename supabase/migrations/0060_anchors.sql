-- On-chain proposal anchors (docs/onchain-anchoring-estimate.md, phase 3):
--
--   * proposals.electorate_hash: sha256 over the voter list, computed by
--     open_proposal_voting with the snapshot, so every ballot can sign it
--     (changing the list after the first ballot would invalidate every ballot
--     already cast) and the "opened" anchor can carry it;
--   * proposals.anchored: whether the proposal's steps are ever due on-chain.
--     Proposals already final when this ships get no anchors; everything
--     open or made from now on does;
--   * proposal_anchors: which transaction carries which step of which
--     proposal (a link table, not a second foreign key from proposals to
--     transactions, which would break bare PostgREST embeds). A step is
--     anchored when its transaction is confirmed, in progress while pending
--     or submitted, and due again once rejected or deleted;
--   * transactions.block_time: when a confirmed transaction landed, from the
--     chain, so an anchor's time can be shown beside the time voting opened.

-- 1. Electorate hash and the anchored flag -------------------------------------------

alter table public.proposals add column electorate_hash text check (electorate_hash ~ '^[0-9a-f]{64}$');
alter table public.proposals add column anchored boolean not null default true;
update public.proposals set anchored = false where state not in ('discussion', 'voting');
create index proposals_anchored_idx on public.proposals(community_id) where anchored;

-- As in 0055, plus the electorate hash: sha256 hex over one line per voter,
-- "<wallet> <0|1>" (1 = recused), sorted by wallet in byte order, joined by
-- "\n" with no trailing newline. The TypeScript checker computes the same
-- (src/lib/governance/electorateHash.ts).
create or replace function public.open_proposal_voting(p_id uuid) returns text
language plpgsql security invoker set search_path = public as $$
declare
  p public.proposals;
  v_n int;
begin
  select * into p from proposals where id = p_id for update;
  if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
  if p.state <> 'discussion' or p.voting_starts_at > now() then return p.state; end if;
  insert into proposal_voters(proposal_id, wallet_address, recused)
    select p.id, e.wallet_address,
      coalesce((p.rules->>'recuseBeneficiaries')::boolean, false) and e.wallet_address = any(p.beneficiaries)
    from proposal_electorate(p.community_id, p.rules->>'electorate', (p.rules->>'activityMonths')::int,
      (p.rules->>'minMemberDays')::int, p.workgroup_ids, p.created_at) e
    on conflict do nothing;
  select count(*) into v_n from proposal_voters where proposal_id = p.id and not recused;
  if v_n = 0 then
    update proposals set state = 'cancelled', closed_at = now(), end_reason = 'No eligible voters',
      execution_state = 'not_applicable', electorate_size = 0 where id = p.id;
    perform deactivate_proposal_budget_owners(p.id);
    insert into proposal_events(proposal_id, community_id, action, detail)
      values (p.id, p.community_id, 'cancelled', jsonb_build_object('reason', 'No eligible voters'));
    return 'cancelled';
  end if;
  update proposals set state = 'voting', voting_opened_at = now(), electorate_size = v_n,
    closes_at = now() + make_interval(hours => (p.rules->>'votingHours')::int),
    electorate_hash = (
      select encode(sha256(convert_to(coalesce(string_agg(
          v.wallet_address || ' ' || case when v.recused then '1' else '0' end,
          E'\n' order by v.wallet_address collate "C"), ''), 'UTF8')), 'hex')
      from proposal_voters v where v.proposal_id = p.id)
    where id = p.id;
  insert into proposal_events(proposal_id, community_id, action, detail)
    values (p.id, p.community_id, 'voting_opened', jsonb_build_object('electorate', v_n));
  return 'voting';
end $$;

-- 2. Block time of confirmed transactions ---------------------------------------------

-- Set by the confirm poller from the chain; null until confirmed (and for
-- rows the chain import created, which carry the block time in submitted_at).
alter table public.transactions add column block_time timestamptz;

-- 3. Anchors ----------------------------------------------------------------------------

create table public.proposal_anchors (
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  step text not null check (step in ('proposed', 'opened', 'closed')),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (proposal_id, step, transaction_id)
);
create index proposal_anchors_transaction_idx on public.proposal_anchors(transaction_id);

-- Link the steps a pending transaction carries (build routes, inside the
-- transaction row's insert). Each entry is {proposalId, step}; every proposal
-- must be an anchored one of the transaction's treasury's community. Returns
-- how many links were new.
create function public.record_proposal_anchors(p_transaction_id uuid, p_anchors jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare
  v_community uuid;
  v_state int;
  v_entry jsonb;
  v_step text;
  v_proposal uuid;
  v_inserted int := 0;
  v_count int;
begin
  select t.community_id, x.state into v_community, v_state
    from transactions x join treasuries t on t.id = x.treasury_id where x.id = p_transaction_id for update of x;
  if not found then raise exception 'Transaction not found' using errcode = 'P0002'; end if;
  if v_state <> 0 then
    raise exception 'Anchors are linked to a pending transaction only' using errcode = '23514';
  end if;
  if jsonb_typeof(p_anchors) <> 'array' then
    raise exception 'Anchors must be a list' using errcode = '23514';
  end if;
  for v_entry in select * from jsonb_array_elements(p_anchors) loop
    v_step := v_entry->>'step';
    if v_step not in ('proposed', 'opened', 'closed') then
      raise exception 'Unknown anchor step %', v_step using errcode = '23514';
    end if;
    begin
      v_proposal := (v_entry->>'proposalId')::uuid;
    exception when others then
      raise exception 'Anchor without a proposal' using errcode = '23514';
    end;
    if not exists (select 1 from proposals where id = v_proposal and community_id = v_community and anchored) then
      raise exception 'Proposal % is not an anchored proposal of this community', v_proposal using errcode = '23514';
    end if;
    insert into proposal_anchors(proposal_id, step, transaction_id) values (v_proposal, v_step, p_transaction_id)
      on conflict do nothing;
    get diagnostics v_count = row_count;
    v_inserted := v_inserted + v_count;
  end loop;
  return v_inserted;
end $$;

-- 4. Access ------------------------------------------------------------------------------

alter table public.proposal_anchors enable row level security;
create policy proposal_anchors_read on public.proposal_anchors for select
  using (exists (select 1 from public.proposals p where p.id = proposal_id and public.is_member(p.community_id)));

revoke all on public.proposal_anchors from anon, authenticated, service_role;
grant select on public.proposal_anchors to authenticated;
grant select, insert, update, delete on public.proposal_anchors to service_role;

revoke all on function public.record_proposal_anchors(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_proposal_anchors(uuid, jsonb) to service_role;
