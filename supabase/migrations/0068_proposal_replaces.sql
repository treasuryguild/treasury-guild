-- Proposal revise: a new proposal may replace one still in discussion. The
-- replacement stores replaces_proposal_id; create_proposal withdraws the old
-- one in the same transaction so budget locks hand off without a gap (and
-- without create-before-withdraw unique conflicts on active owners).

alter table public.proposals
  add column replaces_proposal_id uuid references public.proposals(id);

create index proposals_replaces_idx on public.proposals(replaces_proposal_id)
  where replaces_proposal_id is not null;

-- Recreate with optional p_replaces_id. Drop the draft wrapper first: it calls
-- create_proposal and must be redefined against the new signature.
drop function public.create_proposal_from_draft(text, uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb);
drop function public.create_proposal(uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb);

create function public.create_proposal(
  p_community_id uuid, p_kind text, p_title text, p_body text, p_discussion_url text,
  p_payload jsonb, p_content_hash text, p_rules jsonb, p_rules_hash text,
  p_workgroup_ids uuid[], p_beneficiaries text[], p_proposer text,
  p_budget_owners jsonb default '[]', p_replaces_id uuid default null
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
  v_number int;
  v_state text;
  v_owner text;
  v_old public.proposals;
  v_reason text;
begin
  if not exists (select 1 from community_members where community_id = p_community_id and wallet_address = p_proposer) then
    raise exception 'Only members can make proposals' using errcode = '42501';
  end if;
  -- Numbers are per community; concurrent creations take turns.
  perform pg_advisory_xact_lock(hashtext('proposal_number:' || p_community_id::text));

  if p_replaces_id is not null then
    select * into v_old from proposals where id = p_replaces_id for update;
    if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
    if v_old.community_id <> p_community_id then
      raise exception 'That proposal belongs to another community' using errcode = '23514';
    end if;
    if v_old.proposer <> p_proposer then
      raise exception 'Only the proposer can revise a proposal' using errcode = '42501';
    end if;
    if v_old.state <> 'discussion' then
      raise exception 'A proposal can be revised only before voting opens' using errcode = '23514';
    end if;
    if v_old.kind <> p_kind then
      raise exception 'A revision must keep the same proposal kind' using errcode = '23514';
    end if;
  end if;

  select coalesce(max(number), 0) + 1 into v_number from proposals where community_id = p_community_id;

  -- Free the old proposal's budget locks before inserting the replacement's.
  -- If the insert fails, the whole transaction rolls back and the old proposal
  -- stays in discussion with its locks.
  if p_replaces_id is not null then
    v_reason := 'Revised as #' || v_number::text;
    perform deactivate_proposal_budget_owners(v_old.id);
    update proposals set state = 'withdrawn', closed_at = now(), ended_by = p_proposer,
      end_reason = v_reason, execution_state = 'not_applicable' where id = v_old.id;
    insert into proposal_events(proposal_id, community_id, action, actor, detail)
      values (v_old.id, p_community_id, 'withdrawn', p_proposer,
        jsonb_build_object('reason', v_reason, 'revisedAs', v_number));
  end if;

  insert into proposals(community_id, number, kind, title, body, discussion_url, payload, content_hash,
      rules, rules_hash, workgroup_ids, beneficiaries, proposer, voting_starts_at, replaces_proposal_id)
    values (p_community_id, v_number, p_kind, btrim(p_title), coalesce(p_body, ''), p_discussion_url,
      coalesce(p_payload, '{}'), p_content_hash, p_rules, p_rules_hash, coalesce(p_workgroup_ids, '{}'),
      coalesce(p_beneficiaries, '{}'), p_proposer,
      now() + make_interval(hours => coalesce((p_rules->>'discussionHours')::int, 0)),
      p_replaces_id)
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
  insert into proposal_events(proposal_id, community_id, action, actor, detail)
    values (v_id, p_community_id, 'created', p_proposer,
      case when p_replaces_id is not null
        then jsonb_build_object('replaces', v_old.number)
        else null end);
  v_state := public.open_proposal_voting(v_id);
  return jsonb_build_object('id', v_id, 'number', v_number, 'state', v_state);
end $$;

create function public.create_proposal_from_draft(
  p_draft_id text,
  p_community_id uuid, p_kind text, p_title text, p_body text, p_discussion_url text,
  p_payload jsonb, p_content_hash text, p_rules jsonb, p_rules_hash text,
  p_workgroup_ids uuid[], p_beneficiaries text[], p_proposer text,
  p_budget_owners jsonb default '[]', p_replaces_id uuid default null
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_existing proposals%rowtype;
  v_created jsonb;
begin
  if p_draft_id is null or length(p_draft_id) not between 16 and 128 then
    raise exception 'Invalid draft' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('proposal_draft:' || p_draft_id));
  select * into v_existing from proposals where agent_draft_id = p_draft_id;
  if found then
    if v_existing.community_id <> p_community_id or v_existing.proposer <> p_proposer then
      raise exception 'This draft belongs to another proposal' using errcode = '42501';
    end if;
    return jsonb_build_object('id', v_existing.id, 'number', v_existing.number,
      'state', v_existing.state, 'created', false);
  end if;
  v_created := public.create_proposal(p_community_id, p_kind, p_title, p_body, p_discussion_url,
    p_payload, p_content_hash, p_rules, p_rules_hash, p_workgroup_ids, p_beneficiaries, p_proposer,
    p_budget_owners, p_replaces_id);
  update proposals set agent_draft_id = p_draft_id where id = (v_created->>'id')::uuid;
  return v_created || jsonb_build_object('created', true);
end $$;

revoke all on function public.create_proposal(uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.create_proposal(uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb, uuid)
  to service_role;

revoke all on function public.create_proposal_from_draft(text, uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.create_proposal_from_draft(text, uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb, uuid)
  to service_role;
