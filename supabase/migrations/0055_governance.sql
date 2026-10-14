-- Proposals and voting. A community decides by proposal: a free-text decision,
-- or a budget change that applies itself when it passes ("budget consent").
-- Admins choose, per kind, who may propose, who votes, the decision method and
-- the timing; those rules are frozen onto each proposal when it is created
-- (`rules`, hashed into `rules_hash`), so a later settings change never moves
-- a vote in progress. One member, one vote: the electorate is snapshotted into
-- proposal_voters when voting opens, counting only members who joined before
-- the proposal was created. Every ballot is a CIP-30 signature over a text the
-- server builds (the vote route verifies it like login); the signature is kept
-- for audit. Outcomes are computed by src/lib/governance/tally.ts and recorded
-- by close_proposal under a row lock; a passed budget proposal is applied by
-- execute_proposal through save_budget_setup, all or nothing.
--
-- Kinds 'workgroup' and 'task' are accepted by the checks but have no
-- execution yet (a later migration adds them).

-- 1. Settings -----------------------------------------------------------------

-- One row per community and kind; a missing row means the kind is off (the
-- other defaults live in src/lib/governance/rules.ts).
create table public.governance_settings (
  community_id uuid not null references public.communities(id) on delete cascade,
  kind text not null check (kind in ('budget', 'workgroup', 'task', 'decision')),
  -- budget: budget consent (direct saves refused); decision: members may open polls.
  enabled boolean not null default false,
  proposers text not null check (proposers in ('members', 'managers', 'admins')),
  electorate text not null check (electorate in ('members', 'admins', 'managers', 'workgroup', 'contributors')),
  -- The look-back of the 'workgroup' and 'contributors' electorates.
  activity_months int not null default 12 check (activity_months between 1 and 36),
  min_member_days int not null default 0 check (min_member_days between 0 and 365),
  method text not null check (method in ('consent', 'majority', 'lazy')),
  quorum_pct int not null check (quorum_pct between 0 and 100),
  threshold_pct int not null check (threshold_pct between 50 and 99),
  lazy_objections int not null default 1 check (lazy_objections between 1 and 50),
  lazy_cap_lovelace bigint check (lazy_cap_lovelace is null or lazy_cap_lovelace > 0),
  escalate_method text check (escalate_method in ('consent', 'majority')),
  discussion_hours int not null check (discussion_hours between 0 and 336),
  voting_hours int not null check (voting_hours between 1 and 720),
  hide_results boolean not null default true,
  recuse_beneficiaries boolean not null default false,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (community_id, kind)
);

create table public.governance_setting_changes (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  kind text not null,
  actor text not null,
  before_value jsonb,
  after_value jsonb not null,
  changed_at timestamptz not null default now()
);
create index governance_setting_changes_idx on public.governance_setting_changes(community_id, changed_at desc);

create function public.governance_enabled(p_community_id uuid, p_kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from governance_settings
    where community_id = p_community_id and kind = p_kind), false)
$$;

-- Upsert one kind's settings (snake_case columns in p_settings) and log the change.
create function public.save_governance_settings(
  p_community_id uuid, p_kind text, p_settings jsonb, p_actor text
) returns void language plpgsql security invoker set search_path = public as $$
declare
  v_before jsonb;
  v_row public.governance_settings;
begin
  select to_jsonb(g) into v_before from governance_settings g
    where community_id = p_community_id and kind = p_kind for update;
  v_row := jsonb_populate_record(null::public.governance_settings, p_settings || jsonb_build_object(
    'community_id', p_community_id, 'kind', p_kind, 'updated_by', p_actor, 'updated_at', now()));
  insert into governance_settings select v_row.*
    on conflict (community_id, kind) do update set
      enabled = excluded.enabled, proposers = excluded.proposers, electorate = excluded.electorate,
      activity_months = excluded.activity_months, min_member_days = excluded.min_member_days,
      method = excluded.method, quorum_pct = excluded.quorum_pct, threshold_pct = excluded.threshold_pct,
      lazy_objections = excluded.lazy_objections, lazy_cap_lovelace = excluded.lazy_cap_lovelace,
      escalate_method = excluded.escalate_method, discussion_hours = excluded.discussion_hours,
      voting_hours = excluded.voting_hours, hide_results = excluded.hide_results,
      recuse_beneficiaries = excluded.recuse_beneficiaries, updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;
  insert into governance_setting_changes(community_id, kind, actor, before_value, after_value)
    select p_community_id, p_kind, p_actor, v_before, to_jsonb(g) from governance_settings g
    where community_id = p_community_id and kind = p_kind;
end $$;

-- 2. Proposals ------------------------------------------------------------------

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  number int not null,
  kind text not null check (kind in ('budget', 'workgroup', 'task', 'decision')),
  state text not null default 'discussion'
    check (state in ('discussion', 'voting', 'passed', 'rejected', 'expired', 'withdrawn', 'cancelled')),
  title text not null check (char_length(btrim(title)) between 1 and 140),
  body text not null default '' check (char_length(body) <= 10000),
  discussion_url text check (discussion_url is null or (char_length(discussion_url) <= 500 and discussion_url ~* '^https?://\S+$')),
  -- What passes: the budget steps to apply (kind-specific shape).
  payload jsonb not null default '{}',
  -- sha256 of the canonical {kind, title, body, discussionUrl, payload}: every ballot signs it.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  rules jsonb not null,
  rules_hash text not null check (rules_hash ~ '^[0-9a-f]{64}$'),
  -- The workgroups the proposal concerns ('workgroup' electorate).
  workgroup_ids uuid[] not null default '{}',
  -- Wallets that gain from it, recused when the rules say so.
  beneficiaries text[] not null default '{}',
  proposer text not null,
  created_at timestamptz not null default now(),
  voting_starts_at timestamptz not null,
  voting_opened_at timestamptz,
  closes_at timestamptz,
  closed_at timestamptz,
  electorate_size int,
  ballots_cast int not null default 0,
  -- Bumped by every ballot: close_proposal records a tally of exactly this version.
  ballot_version int not null default 0,
  tally jsonb,
  outcome_reason text,
  execution_state text check (execution_state in ('pending', 'applied', 'failed', 'not_applicable')),
  execution_error text,
  executed_at timestamptz,
  ended_by text,
  end_reason text check (end_reason is null or char_length(end_reason) <= 500),
  unique (community_id, number)
);
create index proposals_community_idx on public.proposals(community_id, created_at desc);
create index proposals_open_idx on public.proposals(state, voting_starts_at, closes_at)
  where state in ('discussion', 'voting') or execution_state = 'pending';

-- The budgets a budget proposal changes. `active` while it may still change
-- them: at most one open proposal per workgroup or treasury budget, so its
-- base revision cannot be overtaken by a second proposal.
create table public.proposal_budget_owners (
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  workgroup_id uuid references public.workgroups(id) on delete cascade,
  treasury_id uuid references public.treasuries(id) on delete cascade,
  owner_key text generated always as (public.budget_owner_key(workgroup_id, treasury_id)) stored,
  base_revision int not null,
  active boolean not null default true,
  check (num_nonnulls(workgroup_id, treasury_id) = 1),
  primary key (proposal_id, owner_key)
);
create unique index proposal_budget_owners_active_uq on public.proposal_budget_owners(owner_key) where active;

create table public.proposal_voters (
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  wallet_address text not null,
  recused boolean not null default false,
  primary key (proposal_id, wallet_address)
);

-- The latest ballot of each voter; changing a vote replaces it.
create table public.proposal_votes (
  proposal_id uuid not null,
  community_id uuid not null references public.communities(id) on delete cascade,
  voter text not null,
  choice text not null check (choice in ('agree', 'abstain', 'disagree', 'block', 'yes', 'no', 'object')),
  reason text check (reason is null or char_length(reason) <= 500),
  -- The time inside the signed text: a ballot older than the stored one is refused.
  signed_at timestamptz not null,
  signed_text text not null check (char_length(signed_text) <= 2000),
  cose_key text not null check (cose_key ~ '^[0-9a-fA-F]+$' and char_length(cose_key) <= 1000),
  cose_signature text not null check (cose_signature ~ '^[0-9a-fA-F]+$' and char_length(cose_signature) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (proposal_id, voter),
  foreign key (proposal_id, voter) references public.proposal_voters(proposal_id, wallet_address) on delete cascade
);

-- No per-ballot event: it would show hidden choices (or at least who voted when).
create table public.proposal_events (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  community_id uuid not null references public.communities(id) on delete cascade,
  action text not null check (action in ('created', 'voting_opened', 'closed', 'executed',
    'execution_failed', 'withdrawn', 'cancelled')),
  actor text,
  detail jsonb,
  occurred_at timestamptz not null default now()
);
create index proposal_events_idx on public.proposal_events(proposal_id, occurred_at);

-- 3. Who votes --------------------------------------------------------------------

-- The one home for eligibility. Every electorate is limited to members who
-- joined at least p_min_member_days before p_cutoff (the proposal's creation).
--   members      every member
--   admins       owners and admins
--   managers     admins and the leads of any workgroup
--   workgroup    leads of the concerned workgroups, and whoever was paid for or
--                assigned to their tasks in the look-back window (with no
--                concerned workgroup: as 'contributors')
--   contributors members paid in the window: a confirmed payout, or a confirmed
--                payment that was not a transfer
create function public.proposal_electorate(
  p_community_id uuid, p_electorate text, p_activity_months int, p_min_member_days int,
  p_workgroup_ids uuid[], p_cutoff timestamptz
) returns table(wallet_address text) language sql stable security invoker set search_path = public as $$
  with m as (
    select cm.wallet_address, cm.role from community_members cm
    where cm.community_id = p_community_id
      and cm.created_at <= p_cutoff - make_interval(days => coalesce(p_min_member_days, 0))
  ),
  since as (select p_cutoff - make_interval(months => coalesce(p_activity_months, 12)) as since_at),
  sel as (
    select case when p_electorate = 'workgroup' and coalesce(cardinality(p_workgroup_ids), 0) = 0
      then 'contributors' else p_electorate end as e
  ),
  paid as (
    select p.contributor_wallet as wallet, t.workgroup_id from payouts p
      join transactions tx on tx.id = p.transaction_id and tx.state = 2
      join tasks t on t.id = p.task_id
      where t.community_id = p_community_id
        and coalesce(tx.submitted_at, tx.created_at) >= (select since_at from since)
  ),
  eligible as (
    select m.wallet_address from m, sel where sel.e = 'members'
    union
    select m.wallet_address from m, sel where sel.e = 'admins' and m.role in ('owner', 'admin')
    union
    select m.wallet_address from m, sel where sel.e = 'managers' and (m.role in ('owner', 'admin')
      or exists (select 1 from workgroup_leads l join workgroups w on w.id = l.workgroup_id
        where w.community_id = p_community_id and l.wallet_address = m.wallet_address))
    union
    select m.wallet_address from m, sel where sel.e = 'workgroup' and (
      exists (select 1 from workgroup_leads l
        where l.workgroup_id = any(p_workgroup_ids) and l.wallet_address = m.wallet_address)
      or exists (select 1 from paid where paid.workgroup_id = any(p_workgroup_ids) and paid.wallet = m.wallet_address)
      or exists (select 1 from task_assignees a join tasks t on t.id = a.task_id
        where t.workgroup_id = any(p_workgroup_ids) and a.wallet_address = m.wallet_address
          and t.created_at >= (select since_at from since)))
    union
    select m.wallet_address from m, sel where sel.e = 'contributors' and (
      exists (select 1 from paid where paid.wallet = m.wallet_address)
      or exists (select 1 from payments pm join transactions tx on tx.id = pm.transaction_id and tx.state = 2
        where pm.community_id = p_community_id and pm.recipient_treasury_id is null
          and pm.recipient_wallet = m.wallet_address
          and coalesce(tx.submitted_at, tx.created_at) >= (select since_at from since)))
  )
  select wallet_address from eligible
$$;

-- 4. Lifecycle ----------------------------------------------------------------------

create function public.deactivate_proposal_budget_owners(p_id uuid) returns void
language sql security invoker set search_path = public as $$
  update proposal_budget_owners set active = false where proposal_id = p_id and active
$$;

-- Snapshot the electorate and open voting once the discussion period is over.
create function public.open_proposal_voting(p_id uuid) returns text
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
    closes_at = now() + make_interval(hours => (p.rules->>'votingHours')::int)
    where id = p.id;
  insert into proposal_events(proposal_id, community_id, action, detail)
    values (p.id, p.community_id, 'voting_opened', jsonb_build_object('electorate', v_n));
  return 'voting';
end $$;

create function public.create_proposal(
  p_community_id uuid, p_kind text, p_title text, p_body text, p_discussion_url text,
  p_payload jsonb, p_content_hash text, p_rules jsonb, p_rules_hash text,
  p_workgroup_ids uuid[], p_beneficiaries text[], p_proposer text, p_budget_owners jsonb default '[]'
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
  v_number int;
  v_state text;
  v_owner text;
begin
  if not exists (select 1 from community_members where community_id = p_community_id and wallet_address = p_proposer) then
    raise exception 'Only members can make proposals' using errcode = '42501';
  end if;
  -- Numbers are per community; concurrent creations take turns.
  perform pg_advisory_xact_lock(hashtext('proposal_number:' || p_community_id::text));
  select coalesce(max(number), 0) + 1 into v_number from proposals where community_id = p_community_id;
  insert into proposals(community_id, number, kind, title, body, discussion_url, payload, content_hash,
      rules, rules_hash, workgroup_ids, beneficiaries, proposer, voting_starts_at)
    values (p_community_id, v_number, p_kind, btrim(p_title), coalesce(p_body, ''), p_discussion_url,
      coalesce(p_payload, '{}'), p_content_hash, p_rules, p_rules_hash, coalesce(p_workgroup_ids, '{}'),
      coalesce(p_beneficiaries, '{}'), p_proposer,
      now() + make_interval(hours => coalesce((p_rules->>'discussionHours')::int, 0)))
    returning id into v_id;
  begin
    insert into proposal_budget_owners(proposal_id, workgroup_id, treasury_id, base_revision)
      select v_id, (o->>'workgroupId')::uuid, (o->>'treasuryId')::uuid, (o->>'baseRevision')::int
      from jsonb_array_elements(coalesce(p_budget_owners, '[]')) o;
  exception when unique_violation then
    select coalesce((select w.name from proposal_budget_owners b join workgroups w on w.id = b.workgroup_id
        where b.active and b.owner_key in (select public.budget_owner_key((o->>'workgroupId')::uuid, (o->>'treasuryId')::uuid)
          from jsonb_array_elements(p_budget_owners) o) limit 1),
      (select t.name from proposal_budget_owners b join treasuries t on t.id = b.treasury_id
        where b.active and b.owner_key in (select public.budget_owner_key((o->>'workgroupId')::uuid, (o->>'treasuryId')::uuid)
          from jsonb_array_elements(p_budget_owners) o) limit 1), 'one of these budgets') into v_owner;
    raise exception 'A budget proposal for % is already open. Wait for it to close.', v_owner using errcode = '23505';
  end;
  insert into proposal_events(proposal_id, community_id, action, actor)
    values (v_id, p_community_id, 'created', p_proposer);
  v_state := public.open_proposal_voting(v_id);
  return jsonb_build_object('id', v_id, 'number', v_number, 'state', v_state);
end $$;

create function public.cast_proposal_vote(
  p_id uuid, p_voter text, p_choice text, p_reason text, p_signed_at timestamptz,
  p_signed_text text, p_key text, p_signature text
) returns int language plpgsql security invoker set search_path = public as $$
declare
  p public.proposals;
  v_recused boolean;
  v_prev timestamptz;
  v_count int;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into p from proposals where id = p_id for update;
  if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
  if p.state <> 'voting' then raise exception 'Voting is not open on this proposal' using errcode = '23514'; end if;
  if now() >= p.closes_at then raise exception 'Voting on this proposal has closed' using errcode = '23514'; end if;
  select recused into v_recused from proposal_voters where proposal_id = p.id and wallet_address = p_voter;
  if not found then
    raise exception 'You are not in this proposal''s electorate' using errcode = '42501';
  end if;
  if v_recused then
    raise exception 'You are recused from this proposal because it benefits you' using errcode = '42501';
  end if;
  if not exists (select 1 from community_members where community_id = p.community_id and wallet_address = p_voter) then
    raise exception 'Only current members can vote' using errcode = '42501';
  end if;
  if not (case p.rules->>'method'
      when 'consent' then p_choice in ('agree', 'abstain', 'disagree', 'block')
      when 'majority' then p_choice in ('yes', 'no', 'abstain')
      when 'lazy' then p_choice in ('agree', 'object')
      else false end) then
    raise exception 'That choice does not exist for this proposal' using errcode = '23514';
  end if;
  if p_choice in ('block', 'object') and v_reason is null then
    raise exception 'Give a reason for your objection' using errcode = '23514';
  end if;
  select signed_at into v_prev from proposal_votes where proposal_id = p.id and voter = p_voter;
  if v_prev is not null and v_prev >= p_signed_at then
    raise exception 'A newer ballot of yours is already recorded' using errcode = '40001';
  end if;
  insert into proposal_votes(proposal_id, community_id, voter, choice, reason, signed_at, signed_text, cose_key, cose_signature)
    values (p.id, p.community_id, p_voter, p_choice, v_reason, p_signed_at, p_signed_text, p_key, p_signature)
    on conflict (proposal_id, voter) do update set choice = excluded.choice, reason = excluded.reason,
      signed_at = excluded.signed_at, signed_text = excluded.signed_text, cose_key = excluded.cose_key,
      cose_signature = excluded.cose_signature, updated_at = now();
  select count(*) into v_count from proposal_votes where proposal_id = p.id;
  update proposals set ballots_cast = v_count, ballot_version = ballot_version + 1 where id = p.id;
  return v_count;
end $$;

-- Record the outcome computed from exactly the ballots of p_expected_version.
-- Closing a closed proposal returns its state.
create function public.close_proposal(
  p_id uuid, p_expected_version int, p_state text, p_tally jsonb, p_reason text
) returns text language plpgsql security invoker set search_path = public as $$
declare
  p public.proposals;
begin
  select * into p from proposals where id = p_id for update;
  if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
  if p.state not in ('discussion', 'voting') then return p.state; end if;
  if p.state <> 'voting' or p.closes_at > now() then
    raise exception 'Voting on this proposal is still open' using errcode = '23514';
  end if;
  if p.ballot_version <> p_expected_version then
    raise exception 'Ballots changed while the result was counted' using errcode = '40001';
  end if;
  if p_state not in ('passed', 'rejected', 'expired') then
    raise exception 'Invalid outcome' using errcode = '23514';
  end if;
  update proposals set state = p_state, tally = p_tally, outcome_reason = p_reason, closed_at = now(),
    execution_state = case when p_state = 'passed' and kind <> 'decision' then 'pending' else 'not_applicable' end
    where id = p.id;
  if p_state <> 'passed' then perform deactivate_proposal_budget_owners(p.id); end if;
  insert into proposal_events(proposal_id, community_id, action, detail)
    values (p.id, p.community_id, 'closed', jsonb_build_object('state', p_state, 'reason', p_reason));
  return p_state;
end $$;

-- Withdraw (the proposer, before voting opens) or cancel (an admin, with a reason).
create function public.end_proposal(p_id uuid, p_actor text, p_action text, p_reason text)
returns text language plpgsql security invoker set search_path = public as $$
declare
  p public.proposals;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into p from proposals where id = p_id for update;
  if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
  if p.state not in ('discussion', 'voting') then
    raise exception 'This proposal is already closed' using errcode = '23514';
  end if;
  if p_action = 'withdrawn' then
    if p.proposer <> p_actor then
      raise exception 'Only the proposer can withdraw a proposal' using errcode = '42501';
    end if;
    if p.state <> 'discussion' then
      raise exception 'A proposal can be withdrawn only before voting opens' using errcode = '23514';
    end if;
  elsif p_action = 'cancelled' then
    if not exists (select 1 from community_members where community_id = p.community_id
        and wallet_address = p_actor and role in ('owner', 'admin')) then
      raise exception 'Only admins can cancel a proposal' using errcode = '42501';
    end if;
    if v_reason is null then raise exception 'Give a reason for cancelling' using errcode = '23514'; end if;
  else
    raise exception 'Invalid action' using errcode = '23514';
  end if;
  update proposals set state = p_action, closed_at = now(), ended_by = p_actor, end_reason = v_reason,
    execution_state = 'not_applicable' where id = p.id;
  perform deactivate_proposal_budget_owners(p.id);
  insert into proposal_events(proposal_id, community_id, action, actor, detail)
    values (p.id, p.community_id, p_action, p_actor, jsonb_build_object('reason', v_reason));
  return p_action;
end $$;

-- 5. Budget consent -------------------------------------------------------------------

-- Apply budget steps through save_budget_setup, chaining each owner's revision
-- from its base. p_owners: [{workgroupId|treasuryId, baseRevision}];
-- p_steps: [{workgroupId|treasuryId, mode, cadence, startsOn, amounts, confirm, reason}].
create function public.run_budget_steps(p_owners jsonb, p_steps jsonb, p_actor text, p_reason_prefix text)
returns void language plpgsql security invoker set search_path = public as $$
declare
  o jsonb;
  s jsonb;
  v_key text;
  v_current int;
  v_name text;
  v_revs jsonb := '{}';
begin
  for o in select * from jsonb_array_elements(p_owners) loop
    v_key := budget_owner_key((o->>'workgroupId')::uuid, (o->>'treasuryId')::uuid);
    select revision into v_current from budget_setup_states where owner_key = v_key;
    if coalesce(v_current, 0) is distinct from (o->>'baseRevision')::int then
      select coalesce((select name from workgroups where id = (o->>'workgroupId')::uuid),
        (select name from treasuries where id = (o->>'treasuryId')::uuid), 'a budget') into v_name;
      raise exception 'The budgets of % changed after this proposal was made', v_name using errcode = '40001';
    end if;
    v_revs := v_revs || jsonb_build_object(v_key, coalesce(v_current, 0));
  end loop;
  for s in select * from jsonb_array_elements(p_steps) loop
    v_key := budget_owner_key((s->>'workgroupId')::uuid, (s->>'treasuryId')::uuid);
    if not v_revs ? v_key then
      raise exception 'A budget change has no listed owner' using errcode = '23514';
    end if;
    v_revs := v_revs || jsonb_build_object(v_key, public.save_budget_setup(
      p_workgroup_id => (s->>'workgroupId')::uuid, p_expected_revision => (v_revs->>v_key)::int,
      p_mode => s->>'mode', p_cadence => s->>'cadence', p_starts_on => (s->>'startsOn')::date,
      p_amounts => s->'amounts', p_actor => p_actor, p_confirm => coalesce((s->>'confirm')::boolean, false),
      p_reason => p_reason_prefix || coalesce(': ' || nullif(btrim(s->>'reason'), ''), ''),
      p_treasury_id => (s->>'treasuryId')::uuid));
  end loop;
end $$;

-- Would these steps apply now? Runs them and rolls back; a refusal raises as is.
create function public.check_budget_proposal(p_owners jsonb, p_steps jsonb, p_actor text)
returns void language plpgsql security invoker set search_path = public as $$
begin
  begin
    perform set_config('guild_vault.proposal_apply', 'check', true);
    perform public.run_budget_steps(p_owners, p_steps, p_actor, 'Proposal check');
    raise exception 'dry run' using errcode = 'GVDRY';
  exception when sqlstate 'GVDRY' then
    null;
  end;
  perform set_config('guild_vault.proposal_apply', '', true);
end $$;

-- Apply a passed proposal. A refusal is recorded (execution_state 'failed' with
-- the message) and the apply rolled back; an admin may retry a failed one.
create function public.execute_proposal(p_id uuid, p_actor text default null)
returns text language plpgsql security invoker set search_path = public as $$
declare
  p public.proposals;
  v_error text;
  v_code text;
begin
  select * into p from proposals where id = p_id for update;
  if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
  if p.state <> 'passed' then raise exception 'Only a passed proposal is carried out' using errcode = '23514'; end if;
  if p.execution_state not in ('pending', 'failed') then return p.execution_state; end if;
  if p.execution_state = 'failed' and p_actor is null then return 'failed'; end if;
  begin
    perform set_config('guild_vault.proposal_apply', p.id::text, true);
    if p.kind = 'budget' then
      perform public.run_budget_steps(
        (select coalesce(jsonb_agg(jsonb_build_object('workgroupId', b.workgroup_id, 'treasuryId', b.treasury_id,
          'baseRevision', b.base_revision)), '[]') from proposal_budget_owners b where b.proposal_id = p.id),
        coalesce(p.payload->'steps', '[]'), p.proposer, 'Proposal #' || p.number);
    else
      raise exception 'Proposals of this kind cannot be carried out yet' using errcode = '23514';
    end if;
    update proposals set execution_state = 'applied', executed_at = now(), execution_error = null where id = p.id;
    insert into proposal_events(proposal_id, community_id, action, actor)
      values (p.id, p.community_id, 'executed', p_actor);
  exception when others then
    get stacked diagnostics v_error = message_text, v_code = returned_sqlstate;
    update proposals set execution_state = 'failed', execution_error = left(v_error, 500) where id = p.id;
    insert into proposal_events(proposal_id, community_id, action, actor, detail)
      values (p.id, p.community_id, 'execution_failed', p_actor, jsonb_build_object('code', v_code, 'message', left(v_error, 500)));
  end;
  perform set_config('guild_vault.proposal_apply', '', true);
  perform deactivate_proposal_budget_owners(p.id);
  return (select execution_state from proposals where id = p.id);
end $$;

-- With budget consent on, budgets change only through execute_proposal (or its
-- dry run), which sets guild_vault.proposal_apply. Not on DELETE: deleting a
-- community or workgroup cascades through these tables.
create function public.guard_budget_consent() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_workgroup uuid;
  v_treasury uuid;
begin
  if coalesce(current_setting('guild_vault.proposal_apply', true), '') <> '' then return new; end if;
  if tg_table_name = 'budget_plans' then
    select workgroup_id, treasury_id into v_workgroup, v_treasury from budget_setups where id = new.setup_id;
  else
    v_workgroup := new.workgroup_id;
    v_treasury := new.treasury_id;
  end if;
  if public.governance_enabled(coalesce(public.workgroup_community(v_workgroup), public.treasury_community(v_treasury)), 'budget') then
    raise exception 'This community changes budgets by proposal' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger budget_setup_states_consent before insert or update on public.budget_setup_states
  for each row execute function public.guard_budget_consent();
create trigger budget_setups_consent before insert or update on public.budget_setups
  for each row execute function public.guard_budget_consent();
create trigger budget_plans_consent before insert or update on public.budget_plans
  for each row execute function public.guard_budget_consent();

-- 6. Access: members read (ballots per the rules), service-role routes write ---------------

create function public.proposal_ballots_visible(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from proposals p where p.id = pid and public.is_member(p.community_id)
    and (p.state not in ('discussion', 'voting') or not coalesce((p.rules->>'hideResults')::boolean, true)))
$$;

alter table public.governance_settings enable row level security;
alter table public.governance_setting_changes enable row level security;
alter table public.proposals enable row level security;
alter table public.proposal_budget_owners enable row level security;
alter table public.proposal_voters enable row level security;
alter table public.proposal_votes enable row level security;
alter table public.proposal_events enable row level security;
create policy governance_settings_read on public.governance_settings for select
  using (public.is_member(community_id));
create policy governance_setting_changes_read on public.governance_setting_changes for select
  using (public.is_member(community_id));
create policy proposals_read on public.proposals for select using (public.is_member(community_id));
create policy proposal_budget_owners_read on public.proposal_budget_owners for select
  using (exists (select 1 from public.proposals p where p.id = proposal_id and public.is_member(p.community_id)));
create policy proposal_voters_read on public.proposal_voters for select
  using (exists (select 1 from public.proposals p where p.id = proposal_id and public.is_member(p.community_id)));
-- Your own ballot always; everyone's once voting closed, or while it runs when results are shown live.
create policy proposal_votes_read on public.proposal_votes for select
  using (public.is_member(community_id)
    and (voter = public.jwt_wallet() or public.proposal_ballots_visible(proposal_id)));
create policy proposal_events_read on public.proposal_events for select using (public.is_member(community_id));

revoke all on public.governance_settings, public.governance_setting_changes, public.proposals,
  public.proposal_budget_owners, public.proposal_voters, public.proposal_votes, public.proposal_events
  from anon, authenticated, service_role;
grant select on public.governance_settings, public.governance_setting_changes, public.proposals,
  public.proposal_budget_owners, public.proposal_voters, public.proposal_votes, public.proposal_events
  to authenticated;
grant select, insert, update, delete on public.governance_settings, public.governance_setting_changes,
  public.proposals, public.proposal_budget_owners, public.proposal_voters, public.proposal_votes,
  public.proposal_events to service_role;

revoke all on function public.save_governance_settings(uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.proposal_electorate(uuid, text, int, int, uuid[], timestamptz) from public, anon, authenticated;
revoke all on function public.deactivate_proposal_budget_owners(uuid) from public, anon, authenticated;
revoke all on function public.open_proposal_voting(uuid) from public, anon, authenticated;
revoke all on function public.create_proposal(uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb)
  from public, anon, authenticated;
revoke all on function public.cast_proposal_vote(uuid, text, text, text, timestamptz, text, text, text) from public, anon, authenticated;
revoke all on function public.close_proposal(uuid, int, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.end_proposal(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.run_budget_steps(jsonb, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.check_budget_proposal(jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.execute_proposal(uuid, text) from public, anon, authenticated;
grant execute on function public.save_governance_settings(uuid, text, jsonb, text) to service_role;
grant execute on function public.proposal_electorate(uuid, text, int, int, uuid[], timestamptz) to service_role;
grant execute on function public.deactivate_proposal_budget_owners(uuid) to service_role;
grant execute on function public.open_proposal_voting(uuid) to service_role;
grant execute on function public.create_proposal(uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb)
  to service_role;
grant execute on function public.cast_proposal_vote(uuid, text, text, text, timestamptz, text, text, text) to service_role;
grant execute on function public.close_proposal(uuid, int, text, jsonb, text) to service_role;
grant execute on function public.end_proposal(uuid, text, text, text) to service_role;
grant execute on function public.run_budget_steps(jsonb, jsonb, text, text) to service_role;
grant execute on function public.check_budget_proposal(jsonb, jsonb, text) to service_role;
grant execute on function public.execute_proposal(uuid, text) to service_role;
