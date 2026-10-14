// Making a proposal: check the kind is on and the proposer may make it,
// freeze the rules, build and dry-run what it would carry out, hash it all.
// The route only parses and rate-limits.
import "server-only";

import type { z } from "zod";
import type { createProposalSchema } from "@/lib/api/schemas";
import type { CreateProposalResponse } from "@/lib/api/types";
import { adaLovelaceFromAmounts } from "@/lib/assets";
import { requireProposer } from "@/lib/authz";
import { DEFAULT_BOARD_COLUMNS } from "@/lib/boardTypes";
import { ProposalKind, TaskSource } from "@/lib/constants";
import {
  loadTreasuryBudgetOwner, loadWorkgroupBudgetOwner, resolveBudgetAmounts, type BudgetOwnerContext,
} from "@/lib/db/budgetSave";
import {
  checkBudgetProposal, createProposal, loadBudgetRevisions, loadGovernanceSettings, loadProposalWorkgroup, nonMembers,
  workgroupLeadWallets, workgroupNameTaken, type NewProposal,
} from "@/lib/db/governance";
import { requireActiveWorkgroup } from "@/lib/db/workgroups";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { proposalContentHash, proposalRulesHash } from "./hash";
import {
  budgetOwnerKey, budgetOwnersOf, switchStartsTooEarly, taskExceedsLazyCap, type BudgetOwnerBase, type BudgetStep,
  type ProposalPayload, type TaskPayload, type WorkgroupPayload,
} from "./payload";
import { rulesFor, type ProposalRules } from "./rules";

type CreateProposalInput = z.infer<typeof createProposalSchema>;
type BudgetSave = Extract<CreateProposalInput, { kind: "budget" }>["saves"][number];

const HOUR_MS = 60 * 60 * 1000;

export async function makeProposal(input: CreateProposalInput, proposer: string): Promise<CreateProposalResponse> {
  return createProposal(await prepareProposal(input, proposer));
}

/**
 * Every check and the exact row `makeProposal` would create, without writing
 * it: the agent API's preview shows this, and its confirmation re-runs it.
 */
export async function prepareProposal(input: CreateProposalInput, proposer: string): Promise<NewProposal> {
  const settings = await loadGovernanceSettings(input.communityId, input.kind);
  if (!settings.enabled) {
    throw new ConflictError(input.kind === ProposalKind.Budget
      ? "Budget consent is off in this community: budgets are saved directly"
      : "Proposals of this kind are off in this community. An admin can turn them on under Governance.");
  }
  let rules = rulesFor(settings);

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
    payload = await taskPayload(input.communityId, input.task);
    if (payload.task.assignSelf) beneficiaries = [proposer];
    // Above the lazy-consensus cap a task is decided like any other proposal.
    rules = rulesFor(settings, {
      escalate: taskExceedsLazyCap(payload.task.amounts, payload.task.bountyLovelace, settings.lazyCapLovelace),
    });
  } else {
    await requireProposer(input.communityId, proposer, settings.proposers, workgroupIds);
  }

  const content = {
    kind: input.kind,
    title: input.title.trim(),
    body: input.body,
    discussionUrl: input.discussionUrl ?? null,
    payload,
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
