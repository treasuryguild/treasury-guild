-- Proposals made through the agent API (MCP proposal_create) are keyed by the
-- draft they were previewed as, so confirming one draft twice, even in the
-- same instant, makes one proposal.
--
-- proposals.agent_draft_id holds the draft token's random id (its jti): no
-- personal data, and useless without the signed token. Null for proposals made
-- in the app.

alter table public.proposals add column agent_draft_id text;
create unique index proposals_agent_draft_uq on public.proposals (agent_draft_id)
  where agent_draft_id is not null;

-- create_proposal for one draft: the proposal that draft already made, or a
-- new one stamped with it. The advisory lock makes a second, concurrent call
-- wait and then find the first one's proposal.
create function public.create_proposal_from_draft(
  p_draft_id text,
  p_community_id uuid, p_kind text, p_title text, p_body text, p_discussion_url text,
  p_payload jsonb, p_content_hash text, p_rules jsonb, p_rules_hash text,
  p_workgroup_ids uuid[], p_beneficiaries text[], p_proposer text, p_budget_owners jsonb default '[]'
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
    p_budget_owners);
  update proposals set agent_draft_id = p_draft_id where id = (v_created->>'id')::uuid;
  return v_created || jsonb_build_object('created', true);
end $$;

revoke all on function public.create_proposal_from_draft(text, uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_proposal_from_draft(text, uuid, text, text, text, text, jsonb, text, jsonb, text, uuid[], text[], text, jsonb)
  to service_role;
