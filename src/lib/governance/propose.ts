// Making a proposal: check the kind is on and the proposer may make it,
// freeze the rules, build and dry-run what it would carry out, hash it all.
// The route only parses and rate-limits.
import "server-only";

import type { z } from "zod";
import type { createProposalSchema } from "@/lib/api/schemas";
import type { CreateProposalResponse } from "@/lib/api/types";
import { adaLovelaceFromAmounts } from "@/lib/assets";
import { memberRole, requireProposer, requireWorkgroupManager } from "@/lib/authz";
import { DEFAULT_BOARD_COLUMNS } from "@/lib/boardTypes";
import { Electorate, ProposalKind, ProposalState, TaskSource } from "@/lib/constants";
import {
  loadTreasuryBudgetOwner, loadWorkgroupBudgetOwner, resolveBudgetAmounts, type BudgetOwnerContext,
} from "@/lib/db/budgetSave";
import {
  checkBudgetProposal, createProposal, electorateWallets, loadBudgetRevisions, loadGovernanceSettings, loadProposal,
  loadProposalWorkgroup, nonMembers, openLeadChange, workgroupLeadWallets, workgroupNameTaken, type NewProposal,
} from "@/lib/db/governance";
import { requireActiveWorkgroup } from "@/lib/db/workgroups";
import { tryEnsureProposalDiscordThread } from "@/lib/discord/proposalThreads";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { isAdminRole } from "@/lib/roles";
import { eligibleVoterCount, noEligibleVotersReason } from "./electorate";
import { proposalContentHash, proposalRulesHash } from "./hash";
import {
  budgetOwnerKey, budgetOwnersOf, isLeadPayload, leadChangeNeedsAdmins, switchStartsTooEarly, taskExceedsLazyCap,
  type BudgetOwnerBase, type BudgetStep, type ProposalPayload, type TaskPayload, type WorkgroupPayload,
} from "./payload";
import { LEAD_CHANGE_RULES, leadEscalationRules, rulesFor, type ProposalRules } from "./rules";

type CreateProposalInput = z.infer<typeof createProposalSchema>;
type BudgetSave = Extract<CreateProposalInput, { kind: "budget" }>["saves"][number];

const HOUR_MS = 60 * 60 * 1000;

export async function makeProposal(input: CreateProposalInput, proposer: string): Promise<CreateProposalResponse> {
  const created = await createProposal(await prepareProposal(input, proposer));
  // Best-effort Discord discussion thread; never fails the create.
  await tryEnsureProposalDiscordThread(created.id);
  return created;
}

/**
 * Every check and the exact row `makeProposal` would create, without writing
 * it: the agent API's preview shows this, and its confirmation re-runs it.
 */
export async function prepareProposal(input: CreateProposalInput, proposer: string): Promise<NewProposal> {
  if (input.kind === ProposalKind.Lead) return prepareLeadChange(input, proposer);
  const settings = await loadGovernanceSettings(input.communityId, input.kind);
  if (!settings.enabled) {
    throw new ConflictError(input.kind === ProposalKind.Budget
      ? "Budget consent is off in this community: budgets are saved directly"
      : "Proposals of this kind are off in this community. An admin can turn them on under Governance.");
  }
  // A proposer may freeze a different set for this proposal. Omitted: the kind's settings.
  let rules = input.rules ?? rulesFor(settings);
  if (rules.electorate === Electorate.Leads) {
    throw new BadRequestError("That electorate is only used for lead changes");
  }

  let payload: ProposalPayload = {};
  let workgroupIds: string[] = [];
  let beneficiaries: string[] = [];
  let budgetOwners: BudgetOwnerBase[] = [];
  if (input.kind === ProposalKind.Budget) {
    budgetOwners = budgetOwnersOf(input.saves);
    workgroupIds = budgetOwners.flatMap((owner) => (owner.workgroupId ? [owner.workgroupId] : []));
    await requireProposer(input.communityId, proposer, settings.proposers, workgroupIds);
    payload = { steps: await budgetSteps(input.communityId, input.saves, budgetOwners, rules, proposer) };
    // The leads of a budgeted workgroup gain from it (recused when the rules say so).
    beneficiaries = await workgroupLeadWallets(workgroupIds);
  } else if (input.kind === ProposalKind.Workgroup) {
    await requireProposer(input.communityId, proposer, settings.proposers, workgroupIds);
    payload = await workgroupPayload(input.communityId, input.workgroup);
    beneficiaries = payload.workgroup.leads;
  } else if (input.kind === ProposalKind.Task) {
    workgroupIds = [input.task.workgroupId];
    await requireProposer(input.communityId, proposer, settings.proposers, workgroupIds);
    if (input.rules) {
      await requireWorkgroupManager(
        input.communityId, input.task.workgroupId, proposer,
        "Only admins and leads of this workgroup can set this task's voting rules",
      );
    }
    payload = await taskPayload(input.communityId, input.task);
    if (payload.task.assignSelf) beneficiaries = [proposer];
    // Above the lazy-consensus cap a task is decided like any other proposal,
    // unless the proposer already chose the rules for this one.
    if (!input.rules) {
      rules = rulesFor(settings, {
        escalate: taskExceedsLazyCap(payload.task.amounts, payload.task.bountyLovelace, settings.lazyCapLovelace),
      });
    }
  } else {
    await requireProposer(input.communityId, proposer, settings.proposers, workgroupIds);
  }

  // Voting would cancel a proposal nobody can vote on, at once or when it opens.
  // The same count the create forms show; a discussion period does not add voters yet.
  const wallets = await electorateWallets(input.communityId, rules, workgroupIds);
  const reason = noEligibleVotersReason(
    wallets.length, eligibleVoterCount(wallets, beneficiaries, rules.recuseBeneficiaries),
  );
  if (reason) throw new BadRequestError(reason);

  const replaces = input.replacesProposalId
    ? await replacesTarget(input.replacesProposalId, input.communityId, input.kind, proposer)
    : null;

  const content = {
    kind: input.kind,
    title: input.title.trim(),
    body: input.body,
    discussionUrl: input.discussionUrl ?? null,
    payload,
    replaces: replaces?.number ?? null,
  };
  return {
    communityId: input.communityId,
    ...content,
    contentHash: proposalContentHash(content),
    rules,
    rulesHash: proposalRulesHash(rules),
    workgroupIds,
    beneficiaries,
    proposer,
    budgetOwners,
    replacesProposalId: replaces?.id ?? null,
  };
}

/** The discussion proposal this create revises, or a refusal. */
async function replacesTarget(
  id: string, communityId: string, kind: ProposalKind, proposer: string,
): Promise<{ id: string; number: number }> {
  const old = await loadProposal(id);
  if (old.community_id !== communityId) throw new BadRequestError("That proposal belongs to another community");
  if (old.proposer !== proposer) throw new ForbiddenError("Only the proposer can revise a proposal");
  if (old.state !== "discussion") throw new ConflictError("A proposal can be revised only before voting opens");
  if (old.kind !== kind) throw new BadRequestError("A revision must keep the same proposal kind");
  return { id: old.id, number: old.number };
}

const ESCALATION_STATES = new Set<string>([ProposalState.Rejected, ProposalState.Expired, ProposalState.Cancelled]);

function sortedWallets(wallets: readonly string[]): string[] {
  return [...new Set(wallets)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A lead change. The workgroup kind must be on. Rules are fixed: the other
 * leads object, unless none of them can, in which case an admin files it and
 * admins decide. An escalation is that admin's wider vote of a change that
 * already failed.
 */
async function prepareLeadChange(
  input: Extract<CreateProposalInput, { kind: typeof ProposalKind.Lead }>,
  proposer: string,
): Promise<NewProposal> {
  if (input.rules !== undefined) throw new BadRequestError("A lead change uses fixed voting rules");
  const workgroupKind = await loadGovernanceSettings(input.communityId, ProposalKind.Workgroup);
  if (!workgroupKind.enabled) {
    throw new ConflictError(
      "Lead changes are proposed while new workgroups are decided by vote. An admin can turn that on under Governance.",
    );
  }
  const workgroup = await loadProposalWorkgroup(input.workgroupId);
  if (!workgroup || workgroup.community_id !== input.communityId) throw new NotFoundError("Workgroup not found");
  if (workgroup.archived_at) throw new ConflictError(`Restore ${workgroup.name} before changing its leads`);

  await requireWorkgroupManager(
    input.communityId, input.workgroupId, proposer,
    "Only admins and leads of this workgroup can propose a lead change",
  );

  const add = sortedWallets(input.add);
  const remove = sortedWallets(input.remove);
  if (add.some((wallet) => remove.includes(wallet))) {
    throw new BadRequestError("A wallet cannot be both added and removed");
  }
  if (add.length + remove.length === 0) throw new BadRequestError("Add or remove at least one lead");
  if ((await nonMembers(input.communityId, add)).length > 0) throw new BadRequestError("Every new lead must be a member");

  const current = await workgroupLeadWallets([input.workgroupId]);
  const currentSet = new Set(current);
  if (add.some((wallet) => currentSet.has(wallet))) throw new BadRequestError("That member already leads this workgroup");
  if (remove.some((wallet) => !currentSet.has(wallet))) throw new BadRequestError("That wallet is not a lead of this workgroup");

  const open = await openLeadChange(input.workgroupId);
  if (open && open.id !== input.replacesProposalId) {
    throw new ConflictError("This workgroup already has an open lead change");
  }

  const escalation = input.escalation ?? null;
  const beneficiaries = sortedWallets([...add, ...remove]);
  const needsAdmins = escalation !== null || leadChangeNeedsAdmins(current, beneficiaries, proposer);
  if (needsAdmins && !isAdminRole(await memberRole(input.communityId, proposer))) {
    throw new ForbiddenError(escalation
      ? "Only an admin can escalate a lead change"
      : "An admin proposes this lead change, and admins decide it");
  }

  let escalates: number | null = null;
  if ((escalation === null) !== (input.escalatesProposalId === undefined)) {
    throw new BadRequestError(escalation
      ? "Name the lead change this escalates"
      : "Choose who votes on the escalation");
  }
  if (escalation) {
    const source = await loadProposal(input.escalatesProposalId!);
    if (source.community_id !== input.communityId) throw new BadRequestError("That proposal belongs to another community");
    if (source.kind !== ProposalKind.Lead || !isLeadPayload(source.payload)) {
      throw new BadRequestError("Only a lead change can be escalated");
    }
    if (!ESCALATION_STATES.has(source.state)) {
      throw new ConflictError("A lead change can be escalated after it is rejected, misses quorum, or is cancelled");
    }
    const prior = source.payload.leadChange;
    if (prior.workgroupId !== input.workgroupId) throw new BadRequestError("That lead change is for another workgroup");
    if (sortedWallets(prior.add).join() !== add.join() || sortedWallets(prior.remove).join() !== remove.join()) {
      throw new BadRequestError("An escalation keeps the same leads added and removed");
    }
    escalates = source.number;
  }

  const rules = escalation
    ? leadEscalationRules(escalation === "members" ? Electorate.Members : Electorate.Workgroup)
    : needsAdmins
      ? { ...LEAD_CHANGE_RULES, electorate: Electorate.Admins }
      : LEAD_CHANGE_RULES;

  const workgroupIds = [input.workgroupId];
  const wallets = await electorateWallets(input.communityId, rules, workgroupIds);
  const reason = noEligibleVotersReason(
    wallets.length, eligibleVoterCount(wallets, beneficiaries, rules.recuseBeneficiaries),
  );
  if (reason) throw new BadRequestError(reason);

  const replaces = input.replacesProposalId
    ? await replacesTarget(input.replacesProposalId, input.communityId, input.kind, proposer)
    : null;
  const payload: ProposalPayload = {
    leadChange: { workgroupId: input.workgroupId, add, remove, escalation, escalates },
  };
  const content = {
    kind: input.kind,
    title: input.title.trim(),
    body: input.body,
    discussionUrl: input.discussionUrl ?? null,
    payload,
    replaces: replaces?.number ?? null,
  };
  return {
    communityId: input.communityId,
    ...content,
    contentHash: proposalContentHash(content),
    rules,
    rulesHash: proposalRulesHash(rules),
    workgroupIds,
    beneficiaries,
    proposer,
    budgetOwners: [],
    replacesProposalId: replaces?.id ?? null,
  };
}

/** A new native workgroup with the default board; its name must be free now (and again when applied). */
async function workgroupPayload(
  communityId: string,
  spec: { name: string; description: string; leads: string[] },
): Promise<WorkgroupPayload> {
  const name = spec.name.trim();
  if (await workgroupNameTaken(communityId, name)) throw new ConflictError(`A workgroup named ${name} already exists`);
  const leads = [...new Set(spec.leads)];
  if ((await nonMembers(communityId, leads)).length > 0) throw new BadRequestError("Every proposed lead must be a member");
  return {
    workgroup: { name, description: spec.description.trim(), leads },
    columns: DEFAULT_BOARD_COLUMNS.map((column) => ({ ...column })),
  };
}

/** A task on an active app board of the community, with its bounty as the board stores it. */
async function taskPayload(
  communityId: string,
  spec: { workgroupId: string; amounts: Record<string, string>; assignSelf: boolean },
): Promise<TaskPayload> {
  const workgroup = await loadProposalWorkgroup(spec.workgroupId);
  if (!workgroup || workgroup.community_id !== communityId) throw new NotFoundError("Workgroup not found");
  if (workgroup.archived_at) throw new ConflictError(`${workgroup.name} is archived`);
  if (workgroup.kind !== TaskSource.Native) {
    throw new BadRequestError(`${workgroup.name} is a GitHub board: its tasks come from GitHub issues`);
  }
  return {
    task: {
      workgroupId: spec.workgroupId,
      amounts: spec.amounts,
      bountyLovelace: adaLovelaceFromAmounts(spec.amounts),
      assignSelf: spec.assignSelf,
    },
  };
}

/**
 * The budget saves as they will be applied: amounts labelled and scaled now
 * (a token must be vouched for by the owner's wallet today), each owner's
 * revision matching the one the proposer edited, and the whole set accepted
 * by a dry run of save_budget_setup.
 */
async function budgetSteps(
  communityId: string,
  saves: BudgetSave[],
  owners: BudgetOwnerBase[],
  rules: ProposalRules,
  proposer: string,
): Promise<BudgetStep[]> {
  const contexts = new Map<string, BudgetOwnerContext>();
  for (const owner of owners) {
    const context = owner.workgroupId
      ? await loadWorkgroupBudgetOwner(owner.workgroupId)
      : await loadTreasuryBudgetOwner(owner.treasuryId!);
    if (context.communityId !== communityId) throw new BadRequestError(`${context.name} belongs to another community`);
    if (owner.workgroupId) await requireActiveWorkgroup(owner.workgroupId);
    contexts.set(budgetOwnerKey(owner), context);
  }

  const revisions = await loadBudgetRevisions(owners);
  for (const owner of owners) {
    if ((revisions.get(budgetOwnerKey(owner)) ?? 0) !== owner.baseRevision) {
      throw new ConflictError("Budgets changed since you opened this page. Reload and review your edits.");
    }
  }

  const steps: BudgetStep[] = [];
  for (const save of saves) {
    if (save.budgets.some((budget) => BigInt(budget.amount) <= 0n)) {
      throw new BadRequestError("Each budget must be greater than zero");
    }
    const ref = { workgroupId: save.workgroupId ?? null, treasuryId: save.treasuryId ?? null };
    steps.push({
      ...ref,
      mode: save.mode,
      cadence: save.budgetCadence,
      startsOn: `${save.startsOn}-01`,
      amounts: await resolveBudgetAmounts(contexts.get(budgetOwnerKey(ref))!, save.budgets, proposer),
      confirm: save.confirmTransition,
      reason: save.reason,
    });
  }

  // A setup change applies no earlier than the month voting can end in.
  const votingEndsAt = new Date(Date.now() + (rules.discussionHours + rules.votingHours) * HOUR_MS);
  const early = switchStartsTooEarly(steps, votingEndsAt);
  if (early) {
    throw new BadRequestError(
      `A setup change from ${early} would be applied after voting ends in ${votingEndsAt.toISOString().slice(0, 7)}. Start it then or later.`,
    );
  }
  await checkBudgetProposal(owners, steps, proposer);
  return steps;
}
