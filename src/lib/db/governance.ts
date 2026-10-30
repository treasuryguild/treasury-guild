// Service-role access to governance (migration 0055): settings, proposals and
// ballots. Members read all of it through RLS in the browser (ballots only as
// the proposal's rules allow); every write is one of the governance RPCs,
// called by a route that authorized first, or by the sweep.
import "server-only";

import { ExecutionState, PgCode, ProposalKind, ProposalState } from "@/lib/constants";
import { isWorkgroupPayload, type BudgetOwnerBase, type BudgetStep, type ProposalPayload } from "@/lib/governance/payload";
import {
  communitySettingsFromRow, settingsFromRow, settingsToRow, type GovernanceCommunitySettings, type GovernanceSettings,
  type ProposalRules,
} from "@/lib/governance/rules";
import type { ProposalTally } from "@/lib/governance/tally";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { isUuid } from "@/lib/guards";
import type { AnchorStep } from "@/lib/constants";
import { loadConfirmedAnchorHashes, loadTallyHashes } from "./anchors";
import { check, maybe, rows, rpc, serviceClient } from "./client";
import {
  GOVERNANCE_COMMUNITY_SETTINGS_COLUMNS, GOVERNANCE_SETTINGS_COLUMNS, PROPOSAL_COLUMNS, PROPOSAL_DOCUMENT_COPY_COLUMNS,
  PROPOSAL_EVENT_COLUMNS, PROPOSAL_TALLY_DOCUMENT_COLUMNS, type DocumentStoreName, type GovernanceCommunitySettingsRow,
  type ProposalEventRow,
  type GovernanceSettingsRow, type ProposalDocumentCopyRow, type ProposalRow, type ProposalTallyDocumentRow,
  type ProposalVoteRow, type ProposalVoterRow,
} from "./types";

const OPEN_STATES = [ProposalState.Discussion, ProposalState.Voting];

// --- Community-level settings (0059) --------------------------------------------

export async function loadGovernanceCommunitySettings(communityId: string): Promise<GovernanceCommunitySettings> {
  const row = maybe<GovernanceCommunitySettingsRow>(
    await serviceClient().from("governance_community_settings").select(GOVERNANCE_COMMUNITY_SETTINGS_COLUMNS)
      .eq("community_id", communityId).maybeSingle(),
    "load community governance settings",
  );
  return communitySettingsFromRow(row);
}

/** Upsert the community-level settings and log the change (save_governance_community_settings). */
export async function saveGovernanceCommunitySettings(
  communityId: string,
  settings: Pick<GovernanceCommunitySettings, "documentStore" | "documentArchiveRepoId" | "documentArchiveFullName" | "spendCheck">,
  actor: string,
): Promise<void> {
  rpc<null>(await serviceClient().rpc("save_governance_community_settings", {
    p_community_id: communityId,
    p_settings: {
      document_store: settings.documentStore,
      document_archive_repo_id: settings.documentArchiveRepoId,
      document_archive_full_name: settings.documentArchiveFullName,
      spend_check: settings.spendCheck,
    },
    p_actor: actor,
  }), { [PgCode.CheckViolation]: BadRequestError });
}

/** A community that publishes frozen documents (0059 / 0067). */
export interface PublishingCommunity {
  community_id: string;
  document_store: DocumentStoreName;
  document_store_since: string;
  document_archive_repo_id: number | null;
  document_archive_full_name: string | null;
}

/** Every community that publishes its frozen documents somewhere. */
export async function listPublishingCommunities(): Promise<PublishingCommunity[]> {
  return rows(
    await serviceClient().from("governance_community_settings")
      .select("community_id, document_store, document_store_since, document_archive_repo_id, document_archive_full_name")
      .not("document_store", "is", null),
    "load publishing communities",
  );
}

// --- Frozen tally documents (0059) ------------------------------------------------

export async function loadTallyDocument(proposalId: string): Promise<ProposalTallyDocumentRow | null> {
  return maybe<ProposalTallyDocumentRow>(
    await serviceClient().from("proposal_tally_documents").select(PROPOSAL_TALLY_DOCUMENT_COLUMNS)
      .eq("proposal_id", proposalId).maybeSingle(),
    "load tally document",
  );
}

/** Store a proposal's frozen document once (freeze_proposal_tally); false when one already exists. */
export async function freezeProposalTally(proposalId: string, document: string, hash: string): Promise<boolean> {
  return rpc<boolean>(await serviceClient().rpc("freeze_proposal_tally", {
    p_proposal_id: proposalId, p_document: document, p_hash: hash,
  }));
}

/** Final proposals that reached voting and have no frozen document yet (the sweep's backlog). */
export async function listProposalsToFreeze(limit = 20): Promise<ProposalRow[]> {
  const db = serviceClient();
  // Newest first: a crash between close and freeze is repaired next run, and
  // at launch the backlog of already-closed proposals drains a page per run.
  const candidates = rows<ProposalRow>(
    await db.from("proposals").select(PROPOSAL_COLUMNS)
      .not("state", "in", `(${OPEN_STATES.join(",")})`)
      .not("voting_opened_at", "is", null)
      .order("closed_at", { ascending: false })
      .limit(200),
    "load final proposals",
  );
  if (candidates.length === 0) return [];
  const frozen = new Set(rows<{ proposal_id: string }>(
    await db.from("proposal_tally_documents").select("proposal_id").in("proposal_id", candidates.map((p) => p.id)),
    "load frozen proposals",
  ).map((row) => row.proposal_id));
  return candidates.filter((p) => !frozen.has(p.id)).slice(0, limit);
}

/** Frozen documents of a community from `since` on, with their copies. */
export async function listDocumentsToPublish(
  communityId: string, since: string, limit = 20,
): Promise<(ProposalTallyDocumentRow & { proposal_document_copies: Pick<ProposalDocumentCopyRow, "store" | "locator">[] })[]> {
  return rows(
    await serviceClient().from("proposal_tally_documents")
      .select(`${PROPOSAL_TALLY_DOCUMENT_COLUMNS}, proposal_document_copies(store, locator)`)
      .eq("community_id", communityId).gte("frozen_at", since).order("frozen_at").limit(limit),
    "load documents to publish",
  );
}

export async function loadDocumentCopies(proposalId: string): Promise<ProposalDocumentCopyRow[]> {
  return rows<ProposalDocumentCopyRow>(
    await serviceClient().from("proposal_document_copies").select(PROPOSAL_DOCUMENT_COPY_COLUMNS)
      .eq("proposal_id", proposalId).order("stored_at"),
    "load document copies",
  );
}

/** Record a copy, replacing an older copy in the same store (a republish after one went missing). */
export async function recordDocumentCopy(copy: {
  proposal_id: string; community_id: string; store: DocumentStoreName; locator: string;
}): Promise<void> {
  const now = new Date().toISOString();
  check(
    await serviceClient().from("proposal_document_copies")
      .upsert({ ...copy, stored_at: now, last_checked_at: now }, { onConflict: "proposal_id,store" }),
    "record document copy",
  );
}

/** Copies not checked since `before`, oldest check first, with their documents. */
export async function listCopiesToCheck(
  before: string, limit = 10,
): Promise<(ProposalDocumentCopyRow & { proposal_tally_documents: Pick<ProposalTallyDocumentRow, "document"> })[]> {
  return rows(
    await serviceClient().from("proposal_document_copies")
      .select(`${PROPOSAL_DOCUMENT_COPY_COLUMNS}, proposal_tally_documents!inner(document)`)
      .lt("last_checked_at", before).order("last_checked_at").limit(limit),
    "load copies to check",
  );
}

export async function markCopyChecked(id: string): Promise<void> {
  check(
    await serviceClient().from("proposal_document_copies").update({ last_checked_at: new Date().toISOString() }).eq("id", id),
    "mark copy checked",
  );
}

// --- Citations (0059) ------------------------------------------------------------------

export type ProposalCitationRow = Pick<ProposalRow, "id" | "number" | "content_hash">;

/** What a spend cites of each proposal: its number and content hash. */
export async function loadProposalCitations(ids: readonly string[]): Promise<Map<string, ProposalCitationRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  return new Map(rows<ProposalCitationRow>(
    await serviceClient().from("proposals").select("id, number, content_hash").in("id", unique),
    "load cited proposals",
  ).map((p) => [p.id, p]));
}

/** A passed and applied budget proposal of the community, else null (build-payment's `proposalId`). */
export async function loadAppliedBudgetProposal(communityId: string, id: string): Promise<ProposalCitationRow | null> {
  if (!isUuid(id)) return null;
  return maybe<ProposalCitationRow>(
    await serviceClient().from("proposals").select("id, number, content_hash")
      .eq("id", id).eq("community_id", communityId).eq("kind", ProposalKind.Budget)
      .eq("state", ProposalState.Passed).eq("execution_state", ExecutionState.Applied).maybeSingle(),
    "load budget proposal",
  );
}

export async function loadGovernanceSettings(communityId: string, kind: ProposalKind): Promise<GovernanceSettings> {
  const row = maybe<GovernanceSettingsRow>(
    await serviceClient().from("governance_settings").select(GOVERNANCE_SETTINGS_COLUMNS)
      .eq("community_id", communityId).eq("kind", kind).maybeSingle(),
    "load governance settings",
  );
  return settingsFromRow(row, kind);
}

/** Upsert one kind's settings and log the change (save_governance_settings). */
export async function saveGovernanceSettings(
  communityId: string, kind: ProposalKind, settings: GovernanceSettings, actor: string,
): Promise<void> {
  rpc<null>(await serviceClient().rpc("save_governance_settings", {
    p_community_id: communityId, p_kind: kind, p_settings: settingsToRow(settings), p_actor: actor,
  }), { [PgCode.CheckViolation]: BadRequestError });
}

/** A proposal by id (a path segment: anything but a uuid is simply not found). */
export async function loadProposal(id: string): Promise<ProposalRow> {
  if (!isUuid(id)) throw new NotFoundError("Proposal not found");
  const proposal = maybe<ProposalRow>(
    await serviceClient().from("proposals").select(PROPOSAL_COLUMNS).eq("id", id).maybeSingle(),
    "load proposal",
  );
  if (!proposal) throw new NotFoundError("Proposal not found");
  return proposal;
}

/** A community's proposal by its number (#N); 404 when it has none. */
export async function loadProposalByNumber(communityId: string, number: number): Promise<ProposalRow> {
  const proposal = maybe<ProposalRow>(
    await serviceClient()
      .from("proposals")
      .select(PROPOSAL_COLUMNS)
      .eq("community_id", communityId)
      .eq("number", number)
      .maybeSingle(),
    "load proposal by number",
  );
  if (!proposal) throw new NotFoundError(`No proposal #${number} in this community`);
  return proposal;
}

/** The choices of every ballot cast, for the tally. */
export async function loadProposalChoices(id: string): Promise<string[]> {
  return rows<{ choice: string }>(
    await serviceClient().from("proposal_votes").select("choice").eq("proposal_id", id),
    "load ballots",
  ).map((vote) => vote.choice);
}

/** The wallet's seat in a proposal's electorate snapshot, or null. */
export async function loadVoter(proposalId: string, wallet: string): Promise<{ recused: boolean } | null> {
  return maybe<{ recused: boolean }>(
    await serviceClient().from("proposal_voters").select("recused")
      .eq("proposal_id", proposalId).eq("wallet_address", wallet).maybeSingle(),
    "load voter",
  );
}

/** Proposals whose next step is due: voting to open, a result to record, a passed one to carry out. */
export async function listDueProposalIds(now: Date, limit = 50): Promise<string[]> {
  const at = now.toISOString();
  return rows<{ id: string }>(
    await serviceClient().from("proposals").select("id")
      .or(`and(state.eq.discussion,voting_starts_at.lte.${at}),and(state.eq.voting,closes_at.lte.${at}),and(state.eq.passed,execution_state.eq.pending)`)
      .order("created_at")
      .limit(limit),
    "load due proposals",
  ).map((row) => row.id);
}

/**
 * Wallets in the electorate of a proposal made now (`proposal_electorate`,
 * cutoff now). Recusal is applied by the caller: beneficiaries stay in this list.
 */
export async function electorateWallets(
  communityId: string, rules: Pick<ProposalRules, "electorate" | "activityMonths" | "minMemberDays">, workgroupIds: string[],
): Promise<string[]> {
  return rpc<{ wallet_address: string }[]>(await serviceClient().rpc("proposal_electorate", {
    p_community_id: communityId, p_electorate: rules.electorate, p_activity_months: rules.activityMonths,
    p_min_member_days: rules.minMemberDays, p_workgroup_ids: workgroupIds, p_cutoff: new Date().toISOString(),
  })).map((row) => row.wallet_address);
}

/** Current budget revisions by owner key (0 for an owner that never had a budget). */
export async function loadBudgetRevisions(owners: readonly BudgetOwnerBase[]): Promise<Map<string, number>> {
  const workgroupIds = owners.flatMap((o) => (o.workgroupId ? [o.workgroupId] : []));
  const treasuryIds = owners.flatMap((o) => (o.treasuryId ? [o.treasuryId] : []));
  const db = serviceClient();
  const [byWorkgroup, byTreasury] = await Promise.all([
    workgroupIds.length ? db.from("budget_setup_states").select("owner_key, revision").in("workgroup_id", workgroupIds) : null,
    treasuryIds.length ? db.from("budget_setup_states").select("owner_key, revision").in("treasury_id", treasuryIds) : null,
  ]);
  const found = [
    ...(byWorkgroup ? rows<{ owner_key: string; revision: number }>(byWorkgroup, "load budget revisions") : []),
    ...(byTreasury ? rows<{ owner_key: string; revision: number }>(byTreasury, "load budget revisions") : []),
  ];
  return new Map(found.map((row) => [row.owner_key, row.revision]));
}

/** Would these budget steps apply now? Runs them in a rolled-back dry run; a refusal throws. */
export async function checkBudgetProposal(owners: BudgetOwnerBase[], steps: BudgetStep[], actor: string): Promise<void> {
  rpc<null>(await serviceClient().rpc("check_budget_proposal", {
    p_owners: owners, p_steps: steps, p_actor: actor,
  }), { [PgCode.CheckViolation]: BadRequestError });
}

export interface NewProposal {
  communityId: string;
  kind: ProposalKind;
  title: string;
  body: string;
  discussionUrl: string | null;
  payload: ProposalPayload;
  contentHash: string;
  rules: ProposalRules;
  rulesHash: string;
  workgroupIds: string[];
  beneficiaries: string[];
  proposer: string;
  budgetOwners: BudgetOwnerBase[];
  /** Discussion proposal this revises (0068); null when it is not a revision. */
  replacesProposalId: string | null;
}

export async function createProposal(p: NewProposal): Promise<{ id: string; number: number; state: string }> {
  return rpc(await serviceClient().rpc("create_proposal", {
    p_community_id: p.communityId, p_kind: p.kind, p_title: p.title, p_body: p.body,
    p_discussion_url: p.discussionUrl, p_payload: p.payload, p_content_hash: p.contentHash,
    p_rules: p.rules, p_rules_hash: p.rulesHash, p_workgroup_ids: p.workgroupIds,
    p_beneficiaries: p.beneficiaries, p_proposer: p.proposer, p_budget_owners: p.budgetOwners,
    p_replaces_id: p.replacesProposalId,
  }), { [PgCode.UniqueViolation]: ConflictError });
}

/**
 * create_proposal for an agent API draft (create_proposal_from_draft, 0064):
 * the proposal this draft already made (`created: false`), or a new one
 * stamped with it. Two confirmations of one draft never make two.
 */
export async function createDraftProposal(
  draftId: string,
  p: NewProposal,
): Promise<{ id: string; number: number; state: string; created: boolean }> {
  return rpc(await serviceClient().rpc("create_proposal_from_draft", {
    p_draft_id: draftId,
    p_community_id: p.communityId, p_kind: p.kind, p_title: p.title, p_body: p.body,
    p_discussion_url: p.discussionUrl, p_payload: p.payload, p_content_hash: p.contentHash,
    p_rules: p.rules, p_rules_hash: p.rulesHash, p_workgroup_ids: p.workgroupIds,
    p_beneficiaries: p.beneficiaries, p_proposer: p.proposer, p_budget_owners: p.budgetOwners,
    p_replaces_id: p.replacesProposalId,
  }), { [PgCode.UniqueViolation]: ConflictError });
}

/** The proposal an agent API draft made, if it made one. */
export async function findProposalByDraft(draftId: string): Promise<{ id: string } | null> {
  return maybe<{ id: string }>(
    await serviceClient().from("proposals").select("id").eq("agent_draft_id", draftId).maybeSingle(),
    "find draft proposal",
  );
}

export interface CastBallot {
  proposalId: string;
  voter: string;
  choice: string;
  reason: string | null;
  signedAt: string;
  signedText: string;
  key: string;
  signature: string;
}

/** Record (or replace) a verified ballot; returns the ballots cast so far. */
export async function castProposalVote(b: CastBallot): Promise<number> {
  return rpc<number>(await serviceClient().rpc("cast_proposal_vote", {
    p_id: b.proposalId, p_voter: b.voter, p_choice: b.choice, p_reason: b.reason,
    p_signed_at: b.signedAt, p_signed_text: b.signedText, p_key: b.key, p_signature: b.signature,
  }));
}

export async function openProposalVoting(id: string): Promise<string> {
  return rpc<string>(await serviceClient().rpc("open_proposal_voting", { p_id: id }));
}

/** Record the tally of exactly `ballotVersion` (a ballot in between is a conflict). */
export async function closeProposal(id: string, ballotVersion: number, tally: ProposalTally): Promise<string> {
  return rpc<string>(await serviceClient().rpc("close_proposal", {
    p_id: id, p_expected_version: ballotVersion, p_state: tally.state, p_tally: tally, p_reason: tally.reason,
  }));
}

/** Carry out a passed proposal; `actor` null for the sweep, which never retries a failure. */
export async function executeProposal(id: string, actor: string | null): Promise<ExecutionState> {
  return rpc<ExecutionState>(await serviceClient().rpc("execute_proposal", { p_id: id, p_actor: actor }));
}

export async function endProposal(
  id: string, actor: string, action: "withdrawn" | "cancelled", reason: string | null,
): Promise<string> {
  return rpc<string>(await serviceClient().rpc("end_proposal", {
    p_id: id, p_actor: actor, p_action: action, p_reason: reason,
  }));
}

/** The open lead change for this workgroup, if one is in discussion or voting. */
export async function openLeadChange(workgroupId: string): Promise<{ id: string; number: number } | null> {
  const found = rows<{ id: string; number: number }>(
    await serviceClient().from("proposals").select("id, number")
      .eq("kind", ProposalKind.Lead)
      .in("state", [ProposalState.Discussion, ProposalState.Voting])
      .filter("payload->leadChange->>workgroupId", "eq", workgroupId)
      .limit(1),
    "load open lead change",
  );
  return found[0] ?? null;
}

/** The leads of the given workgroups: who gains from their budgets. */
export async function workgroupLeadWallets(workgroupIds: string[]): Promise<string[]> {
  if (workgroupIds.length === 0) return [];
  return [...new Set(rows<{ wallet_address: string }>(
    await serviceClient().from("workgroup_leads").select("wallet_address").in("workgroup_id", workgroupIds),
    "load workgroup leads",
  ).map((row) => row.wallet_address))];
}

/** An active workgroup of the community already has this name (workgroup_name_taken). */
export async function workgroupNameTaken(communityId: string, name: string): Promise<boolean> {
  return rpc<boolean>(await serviceClient().rpc("workgroup_name_taken", { p_community_id: communityId, p_name: name }));
}

/** The wallets among `wallets` that are not members of the community. */
export async function nonMembers(communityId: string, wallets: string[]): Promise<string[]> {
  if (wallets.length === 0) return [];
  const members = new Set(rows<{ wallet_address: string }>(
    await serviceClient().from("community_members").select("wallet_address")
      .eq("community_id", communityId).in("wallet_address", wallets),
    "load members",
  ).map((row) => row.wallet_address));
  return wallets.filter((wallet) => !members.has(wallet));
}

/** The board a task is proposed on, or null. */
export async function loadProposalWorkgroup(workgroupId: string): Promise<
  { community_id: string; name: string; kind: string; archived_at: string | null } | null
> {
  return maybe(
    await serviceClient().from("workgroups").select("community_id, name, kind, archived_at").eq("id", workgroupId).maybeSingle(),
    "load workgroup",
  );
}

export interface ProposalListing {
  proposals: ProposalRow[];
  /** Proposals matching the filter, of which `proposals` is the newest `limit`. */
  total: number;
  /** The wallet's own ballot per proposal id. */
  myVotes: Map<string, Pick<ProposalVoteRow, "choice" | "reason" | "signed_at">>;
  /** The wallet's seat per proposal id: recused or not. */
  mySeats: Map<string, boolean>;
  /** Display handles of the wallets the proposals name (proposers, leads). */
  handles: Map<string, string | null>;
  /** Names of the community's workgroups and treasuries by id. */
  ownerNames: Map<string, string>;
  /** The frozen tally document's hash per proposal id, where one exists (0059). */
  tallyHashes: Map<string, string>;
  /** Confirmed anchor transaction hashes per proposal id and step (0060). */
  anchors: Map<string, Partial<Record<AnchorStep, string>>>;
}

/** A community's proposals, newest first, with what the wallet needs to read them (agent API). */
export async function loadProposalListing(
  communityId: string,
  wallet: string,
  filter: { open: boolean | null; limit: number; number?: number },
): Promise<ProposalListing> {
  const db = serviceClient();
  let query = db.from("proposals").select(PROPOSAL_COLUMNS, { count: "exact" }).eq("community_id", communityId);
  if (filter.open === true) query = query.in("state", OPEN_STATES);
  if (filter.open === false) query = query.not("state", "in", `(${OPEN_STATES.join(",")})`);
  if (filter.number !== undefined) query = query.eq("number", filter.number);
  const listed = await query.order("created_at", { ascending: false }).limit(filter.limit);
  const proposals = rows<ProposalRow>(listed, "load proposals");
  const ids = proposals.map((p) => p.id);
  const wallets = [...new Set(proposals.flatMap((p) => [
    p.proposer, ...(isWorkgroupPayload(p.payload) ? p.payload.workgroup.leads : []),
  ]))];
  const [votes, seats, contributors, workgroups, treasuries, tallyHashes, anchors] = await Promise.all([
    ids.length ? db.from("proposal_votes").select("proposal_id, choice, reason, signed_at").eq("voter", wallet).in("proposal_id", ids) : null,
    ids.length ? db.from("proposal_voters").select("proposal_id, recused").eq("wallet_address", wallet).in("proposal_id", ids) : null,
    wallets.length ? db.from("contributors").select("wallet_address, handle").in("wallet_address", wallets) : null,
    db.from("workgroups").select("id, name").eq("community_id", communityId),
    db.from("treasuries").select("id, name").eq("community_id", communityId),
    loadTallyHashes(ids),
    loadConfirmedAnchorHashes(ids),
  ]);
  return {
    proposals,
    total: listed.count ?? proposals.length,
    tallyHashes,
    anchors,
    myVotes: new Map((votes ? rows<Pick<ProposalVoteRow, "proposal_id" | "choice" | "reason" | "signed_at">>(votes, "load own ballots") : [])
      .map((v) => [v.proposal_id, { choice: v.choice, reason: v.reason, signed_at: v.signed_at }])),
    mySeats: new Map((seats ? rows<{ proposal_id: string; recused: boolean }>(seats, "load own seats") : [])
      .map((s) => [s.proposal_id, s.recused])),
    handles: new Map((contributors ? rows<{ wallet_address: string; handle: string | null }>(contributors, "load handles") : [])
      .map((c) => [c.wallet_address, c.handle])),
    ownerNames: new Map([
      ...rows<{ id: string; name: string }>(workgroups, "load workgroups"),
      ...rows<{ id: string; name: string }>(treasuries, "load treasuries"),
    ].map((o) => [o.id, o.name])),
  };
}

/** A proposal's lifecycle steps, oldest first (members read them in the app). */
export async function loadProposalEvents(proposalId: string): Promise<ProposalEventRow[]> {
  return rows<ProposalEventRow>(
    await serviceClient().from("proposal_events").select(PROPOSAL_EVENT_COLUMNS)
      .eq("proposal_id", proposalId).order("occurred_at"),
    "load proposal events",
  );
}

/** The electorate snapshot and every ballot of a proposal, for its tally document. */
export async function loadProposalBallots(proposalId: string): Promise<{
  voters: Pick<ProposalVoterRow, "wallet_address" | "recused">[];
  votes: Pick<ProposalVoteRow, "voter" | "choice" | "reason" | "signed_at" | "signed_text" | "cose_key" | "cose_signature">[];
}> {
  const db = serviceClient();
  const [voters, votes] = await Promise.all([
    db.from("proposal_voters").select("wallet_address, recused").eq("proposal_id", proposalId),
    db.from("proposal_votes").select("voter, choice, reason, signed_at, signed_text, cose_key, cose_signature").eq("proposal_id", proposalId),
  ]);
  return {
    voters: rows(voters, "load electorate"),
    votes: rows(votes, "load ballots"),
  };
}
