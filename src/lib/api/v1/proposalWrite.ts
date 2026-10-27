// Making a proposal through the agent API, in two steps: proposal_preview runs
// every check the app's own form runs (prepareProposal) and writes nothing; it
// answers with what the proposal would be and a draft token. proposal_create
// takes only that token, after the user said yes, and creates exactly what was
// previewed, or refuses when anything it depends on changed since. The
// proposal is keyed by the draft (create_proposal_from_draft, migration 0064),
// so confirming one draft twice, even at once, makes one proposal.
//
// A proposal changes nothing by itself: members vote on it in the app with
// their wallets.
import "server-only";

import { z } from "zod";
import type { ApiCaller } from "@/lib/api/caller";
import { createProposalSchema, proposalRulesInput } from "@/lib/api/schemas";
import { parseInput } from "@/lib/api/parse";
import type { V1ProposalCreateResponse, V1ProposalPreviewResponse } from "@/lib/api/types";
import { ADA_ASSET, LOVELACE, scaleDecimal } from "@/lib/assets";
import { sha256Hex } from "@/lib/auth/crypto";
import { applyWalletTokenHint } from "@/lib/cardano/assetInfo";
import { asNetwork } from "@/lib/config";
import { MAX_PROPOSAL_BODY, MAX_PROPOSAL_TITLE, ProposalKind } from "@/lib/constants";
import { loadAssetRegistry, loadMintAssetHints } from "@/lib/db/assets";
import {
  loadTreasuryBudgetOwner, loadWorkgroupBudgetOwner, resolveBudgetAmounts, type BudgetOwnerContext,
} from "@/lib/db/budgetSave";
import { loadSetupInForce } from "@/lib/db/budgetSetups";
import { createDraftProposal, findProposalByDraft, loadBudgetRevisions, loadProposal, type NewProposal } from "@/lib/db/governance";
import { loadMemberLabels } from "@/lib/db/payments";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { listCommunityTreasuries } from "@/lib/db/treasuries";
import { listCommunityWorkgroups } from "@/lib/db/workgroups";
import { BadRequestError, ConflictError, errorMessage } from "@/lib/errors";
import { truncate } from "@/lib/format";
import { proposalChangeLines } from "@/lib/governance/describe";
import { describeElectorate, describeMethod, voterName } from "@/lib/governance/labels";
import {
  budgetOwnerKey, isBudgetPayload, isTaskPayload, isWorkgroupPayload, MAX_BUDGET_STEPS, type ProposalPayload,
} from "@/lib/governance/payload";
import { prepareProposal } from "@/lib/governance/propose";
import { canonicalJson } from "@/lib/governance/rules";
import { mintDraftToken, verifyDraftToken, type VerifiedDraft } from "@/lib/mcp/draftToken";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import {
  appLink, communityInput, communityMemberRefs, memberCommunity, requireMember, resolveCommunityTreasury,
  resolveCommunityWorkgroup,
} from "./shared";

const TEXT_MAX = 2000;
const HOUR_MS = 60 * 60 * 1000;

const EFFECTS = [
  "Every member of the community can read it as soon as it is created.",
  "It is announced on the community's Discord channel, if one is connected.",
  "Its content and rules fingerprints are recorded on the Cardano chain with the community's next transaction.",
  "It is made in the user's name; nothing changes unless it passes the vote.",
  "The user can withdraw it in the app while it is in discussion.",
];

const REVISE_EFFECTS = [
  "The named discussion proposal is withdrawn in the same step and linked as what this revises.",
  "Discussion and voting periods start again from when this proposal is created.",
  ...EFFECTS,
];

type CreateRequest = z.infer<typeof createProposalSchema>;

const month = z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/, "Use a month as YYYY-MM");

const budgetChange = z.object({
  owner: z.string().trim().min(1).max(200)
    .describe("The workgroup (or, with ownerType treasury, the treasury) whose budget changes: name or id"),
  ownerType: z.enum(["workgroup", "treasury"]).default("workgroup")
    .describe("workgroup: its task payouts count against the budget; treasury: manual payments made from it"),
  plan: z.enum(["recurring", "period"])
    .describe("recurring: these amounts every period from startsOn on; period: only the one month or quarter starting at startsOn"),
  cadence: z.enum(["monthly", "quarterly"]).describe("Budget per month or per calendar quarter"),
  startsOn: month.describe("First month it applies to, YYYY-MM (a quarter's first month for quarterly)"),
  amounts: z.record(z.string(), z.string())
    .describe('Budget per period, ticker -> amount in display units, e.g. {"ADA": "5000"}'),
  reason: z.string().trim().max(500).optional()
    .describe("Why; required when correcting a past period"),
});

const previewInput = z.object({
  community: communityInput,
  kind: z.enum([ProposalKind.Decision, ProposalKind.Task, ProposalKind.Workgroup, ProposalKind.Budget])
    .describe("decision: a question put to a vote, nothing applied; task: a new task with a bounty on an app board; workgroup: a new workgroup with an app board; budget: budget changes that apply when it passes (needs budget consent on)"),
  title: z.string().trim().min(1).max(MAX_PROPOSAL_TITLE)
    .describe("For a task, the task's title"),
  body: z.string().trim().max(MAX_PROPOSAL_BODY).default("")
    .describe("The proposal's text: what and why. For a task, the task's description"),
  discussionUrl: z.string().trim().max(500).optional()
    .describe("Link to where it is being discussed (http or https)"),
  rules: proposalRulesInput.optional()
    .describe("Voting rules for this proposal only. Omit to use the community's defaults for the kind. Fixed once the proposal is created; they cannot be changed during discussion or voting."),
  replacesProposalId: z.string().uuid().optional()
    .describe("Id of your own discussion proposal to withdraw and replace with this one (same kind). The new proposal starts a fresh discussion period and links to the old number."),
  task: z.object({
    workgroup: z.string().trim().min(1).max(200)
      .describe("The app board it goes on: a workgroup's name or id, as workgroup_list returns it"),
    reward: z.record(z.string(), z.string())
      .describe('Bounty paid to each assignee, ticker -> amount in display units, e.g. {"ADA": "250"}'),
    assignSelf: z.boolean().default(false)
      .describe("Assign the task to the user making the proposal"),
  }).optional().describe("Required for kind task"),
  workgroup: z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(1000).default(""),
    leads: z.array(z.string().trim().min(1).max(200)).max(10).default([])
      .describe("Members who will lead it: name, @GitHub login or wallet, as member_list shows them"),
  }).optional().describe("Required for kind workgroup"),
  budget: z.object({
    changes: z.array(budgetChange).min(1).max(MAX_BUDGET_STEPS),
  }).optional().describe("Required for kind budget: one entry per budget that changes"),
});

type PreviewInput = z.infer<typeof previewInput>;
type BudgetChange = z.infer<typeof budgetChange>;

/** The app's create body for the preview's input, validated by the app's own schema. */
async function createRequest(communityId: string, input: PreviewInput, wallet: string): Promise<CreateRequest> {
  const text = {
    communityId, title: input.title, body: input.body, discussionUrl: input.discussionUrl,
    ...(input.rules ? { rules: input.rules } : {}),
    ...(input.replacesProposalId ? { replacesProposalId: input.replacesProposalId } : {}),
  };
  let body: Record<string, unknown>;
  if (input.kind === ProposalKind.Task) {
    if (!input.task) throw new BadRequestError("A task proposal needs task: { workgroup, reward }");
    const workgroup = await resolveCommunityWorkgroup(communityId, input.task.workgroup);
    body = { ...text, kind: input.kind, task: { workgroupId: workgroup.id, amounts: input.task.reward, assignSelf: input.task.assignSelf } };
  } else if (input.kind === ProposalKind.Workgroup) {
    if (!input.workgroup) throw new BadRequestError("A workgroup proposal needs workgroup: { name }");
    const members = input.workgroup.leads.length > 0 ? await communityMemberRefs(communityId) : [];
    const leads = input.workgroup.leads.map((lead) => requireMember(lead, members).wallet);
    body = { ...text, kind: input.kind, workgroup: { ...input.workgroup, leads } };
  } else if (input.kind === ProposalKind.Budget) {
    if (!input.budget) throw new BadRequestError("A budget proposal needs budget: { changes: [...] }");
    body = { ...text, kind: input.kind, saves: await budgetSaves(communityId, input.budget.changes, wallet) };
  } else {
    body = { ...text, kind: input.kind };
  }
  return parseInput(createProposalSchema, body);
}

/**
 * The Budgets page's saves for these changes (the shape of budgetSaveBodies):
 * owners and tokens resolved, amounts scaled with the decimals the proposal
 * itself will store, each owner's base revision read now (a later change to
 * that budget then refuses the confirmation), and the setup-change flag set
 * when the mode or cadence in force at the start differs.
 */
async function budgetSaves(communityId: string, changes: readonly BudgetChange[], wallet: string) {
  const registry = await loadAssetRegistry(communityId);
  const saves = [];
  for (const change of changes) {
    const owner = change.ownerType === "treasury"
      ? { workgroupId: null, treasuryId: (await resolveCommunityTreasury(communityId, change.owner)).id }
      : { workgroupId: (await resolveCommunityWorkgroup(communityId, change.owner)).id, treasuryId: null };
    const context = owner.workgroupId
      ? await loadWorkgroupBudgetOwner(owner.workgroupId)
      : await loadTreasuryBudgetOwner(owner.treasuryId!);
    const startsOn = `${change.startsOn}-01`;
    const [revisions, inForce] = await Promise.all([
      loadBudgetRevisions([{ ...owner, baseRevision: 0 }]),
      loadSetupInForce(budgetOwnerKey(owner), startsOn),
    ]);
    const mode = change.plan === "recurring" ? "recurring" : change.cadence;
    const budgets = await budgetAmounts(context, registry, change, wallet);
    saves.push({
      ...(owner.workgroupId ? { workgroupId: owner.workgroupId } : { treasuryId: owner.treasuryId }),
      budgetMonth: change.plan === "period" ? change.startsOn : null,
      budgetCadence: change.cadence,
      mode,
      startsOn: change.startsOn,
      expectedRevision: revisions.get(budgetOwnerKey(owner)) ?? 0,
      confirmTransition: !inForce || inForce.mode !== mode || inForce.cadence !== change.cadence,
      reason: change.reason ?? "",
      budgets,
    });
  }
  return saves;
}

/** One change's amounts in base units, each token named by ticker (or unit). */
async function budgetAmounts(
  context: BudgetOwnerContext,
  registry: { fieldName: string; unit: string }[],
  change: BudgetChange,
  wallet: string,
): Promise<{ cadence: string; unit: string; amount: string }[]> {
  const entries = Object.entries(change.amounts);
  if (entries.length === 0) throw new BadRequestError(`Give ${context.name} at least one amount`);

  // Tickers of tokens the owner's wallet holds, read only when the registry lacks one.
  let held: Map<string, string> | null = null;
  const heldTokens = async (): Promise<Map<string, string>> => {
    if (held) return held;
    held = new Map();
    if (!context.wallet) return held;
    await enforceRateLimit("chainProxy", wallet);
    const { fetchWalletAssets } = await import("@/lib/cardano/walletAssets");
    const { tokens } = await fetchWalletAssets(asNetwork(context.wallet.network), context.wallet.address);
    const hints = await loadMintAssetHints(tokens.map((t) => t.unit));
    for (const token of tokens) {
      const ticker = applyWalletTokenHint(token, hints.get(token.unit)).ticker;
      if (ticker) held.set(ticker.toLowerCase(), token.unit);
    }
    return held;
  };

  const units: string[] = [];
  for (const [key] of entries) {
    const k = key.trim();
    const lower = k.toLowerCase();
    const unit = lower === "ada" || lower === LOVELACE
      ? LOVELACE
      : registry.find((a) => a.unit === k || a.fieldName.toLowerCase() === lower)?.unit
        ?? (/^[0-9a-f]{56,120}$/i.test(k) ? k.toLowerCase() : (await heldTokens()).get(lower));
    if (!unit) {
      const known = ["ADA", ...registry.map((a) => a.fieldName), ...[...(await heldTokens()).keys()].map((t) => t.toUpperCase())];
      throw new BadRequestError(`No token "${key}" for ${context.name}. Known tokens: ${[...new Set(known)].join(", ")}`);
    }
    units.push(unit);
  }

  // The labels and decimals the proposal will store, from the same resolver.
  const resolved = await resolveBudgetAmounts(context, units.map((unit) => ({ unit, cadence: change.cadence, amount: "1" })), wallet);
  return entries.map(([key, amount], i) => {
    const decimals = units[i] === LOVELACE ? ADA_ASSET.decimals : resolved[i]!.decimals;
    let quantity: bigint;
    try {
      quantity = scaleDecimal(amount, decimals);
    } catch (err) {
      throw new BadRequestError(`${key} for ${context.name}: ${errorMessage(err, "invalid amount")}`);
    }
    if (quantity <= 0n) throw new BadRequestError(`${key} for ${context.name} must be greater than zero`);
    return { cadence: change.cadence, unit: units[i]!, amount: quantity.toString() };
  });
}

/**
 * What the user confirms, stable between the preview and the confirmation: the
 * content hash itself is not, as a budget amount carries the time it was
 * resolved (`updated_at`) and who resolved it.
 */
export function draftFingerprint(p: NewProposal): string {
  const payload: ProposalPayload = isBudgetPayload(p.payload)
    ? {
        ...p.payload,
        steps: p.payload.steps.map((step) => ({
          ...step,
          amounts: step.amounts.map(({ unit, amount, asset_label, decimals }) => ({ unit, amount, asset_label, decimals })),
        })),
      }
    : p.payload;
  return sha256Hex(canonicalJson({
    kind: p.kind, title: p.title, body: p.body, discussionUrl: p.discussionUrl, payload,
    workgroupIds: p.workgroupIds, beneficiaries: p.beneficiaries, budgetOwners: p.budgetOwners,
    replacesProposalId: p.replacesProposalId,
  }));
}

/** "What passing it changes", with the names a member would see. */
async function changeLines(communityId: string, proposal: NewProposal): Promise<string[]> {
  const { payload } = proposal;
  const wallets = [proposal.proposer, ...(isWorkgroupPayload(payload) ? payload.workgroup.leads : [])];
  const budget = isBudgetPayload(payload);
  const [labels, workgroups, treasuries] = await Promise.all([
    loadMemberLabels(communityId, wallets),
    isTaskPayload(payload) || budget ? listCommunityWorkgroups(communityId) : Promise.resolve([]),
    budget ? listCommunityTreasuries(communityId) : Promise.resolve([]),
  ]);
  const names = new Map([...workgroups, ...treasuries].map((o) => [o.id, o.name]));
  return proposalChangeLines(
    { payload, proposer: proposal.proposer },
    { owner: (id) => names.get(id), member: (wallet) => voterName(wallet, labels.get(wallet)) },
  );
}

export const previewProposal = defineEndpoint({
  scope: "proposals:write",
  input: previewInput,
  async run(caller, input): Promise<V1ProposalPreviewResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const request = await createRequest(community.id, input, caller.wallet);
    const proposal = await prepareProposal(request, caller.wallet);
    const { token, expiresAt } = await mintDraftToken(caller, {
      action: "proposal_create",
      community: community.slug,
      request,
      fingerprint: draftFingerprint(proposal),
      rulesHash: proposal.rulesHash,
    });

    const opens = Date.now() + proposal.rules.discussionHours * HOUR_MS;
    return {
      community: { slug: community.slug, name: community.name },
      proposal: {
        kind: proposal.kind,
        title: proposal.title,
        text: truncate(proposal.body, TEXT_MAX),
        discussionUrl: proposal.discussionUrl,
        changes: await changeLines(community.id, proposal),
        decidedBy: describeMethod(proposal.rules),
        electorate: describeElectorate(proposal.rules),
        discussionHours: proposal.rules.discussionHours,
        votingHours: proposal.rules.votingHours,
        votingOpensAround: new Date(opens).toISOString(),
        votingClosesAround: new Date(opens + proposal.rules.votingHours * HOUR_MS).toISOString(),
      },
      effects: input.replacesProposalId ? REVISE_EFFECTS : EFFECTS,
      next: "Nothing has been created. Show this preview to the user and call proposal_create with draftToken only if they say yes, before expiresAt.",
      draftToken: token,
      expiresAt,
    };
  },
});

export const createProposalFromDraft = defineEndpoint({
  scope: "proposals:write",
  input: z.object({
    draftToken: z.string().min(1).max(32_000).describe("The draftToken proposal_preview returned"),
    community: communityInput.optional().describe("The previewed community's slug; taken from the token when omitted"),
  }),
  async run(caller, input): Promise<V1ProposalCreateResponse> {
    const draft = await verifyDraftToken(input.draftToken, caller, "proposal_create");
    if (input.community && input.community !== draft.community) {
      throw new BadRequestError(`This draft was previewed for ${draft.community}, not ${input.community}`);
    }
    return confirmProposalCreate(caller, draft);
  },
});

/** The proposal_create action: what proposal_create and draft_confirm run for a verified proposal draft. */
export async function confirmProposalCreate(caller: ApiCaller, draft: VerifiedDraft): Promise<V1ProposalCreateResponse> {
  {
    const { community } = await memberCommunity(caller, draft.community);
    const request = parseInput(createProposalSchema, draft.request);
    if (request.communityId !== community.id) throw new BadRequestError("This draft belongs to another community");

    const answer = async (created: boolean, id: string): Promise<V1ProposalCreateResponse> => {
      const p = await loadProposal(id);
      return {
        community: { slug: community.slug, name: community.name },
        created,
        number: p.number,
        state: p.state,
        title: p.title,
        votingOpensAt: p.voting_starts_at,
        votingClosesAt: p.closes_at,
        url: appLink(routes.proposal(community.slug, p.id)),
      };
    };

    // A repeated confirmation answers with the proposal the first one made,
    // before re-checking: a budget proposal, once made, holds its budgets.
    const existing = await findProposalByDraft(draft.draftId);
    if (existing) return answer(false, existing.id);

    let proposal: NewProposal;
    try {
      proposal = await prepareProposal(request, caller.wallet);
    } catch (err) {
      if (err instanceof ConflictError) throw new ConflictError(`${err.message} Preview the proposal again.`);
      throw err;
    }
    if (draftFingerprint(proposal) !== draft.fingerprint || proposal.rulesHash !== draft.rulesHash) {
      throw new ConflictError(
        "The community's proposal rules or this proposal's details changed since the preview. Preview it again and show the user the new version.",
      );
    }
    await enforceRateLimit("proposalCreate", caller.wallet);
    // Keyed by the draft: a confirmation racing this one gets this proposal back.
    const made = await createDraftProposal(draft.draftId, proposal);
    return answer(made.created, made.id);
  }
}
