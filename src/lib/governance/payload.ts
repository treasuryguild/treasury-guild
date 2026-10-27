// What a proposal carries out when it passes (proposals.payload), per kind.
// A budget proposal holds the budget saves the worksheet would have made, in
// order, applied through save_budget_setup when it passes: each owner's
// revision is chained from the one the proposal was made against. A
// workgroup proposal holds the workgroup and its board columns; a task
// proposal the task's board and bounty (its title and text are the
// proposal's). Client-safe.
import type { BudgetAmount, BudgetMode } from "@/lib/budgetSetups";
import type { BudgetCadence } from "@/lib/budgets";

/** One save_budget_setup call. */
export interface BudgetStep {
  workgroupId: string | null;
  treasuryId: string | null;
  mode: BudgetMode;
  cadence: BudgetCadence;
  /** "YYYY-MM-01" */
  startsOn: string;
  /** With labels and decimals resolved when the proposal was made. */
  amounts: BudgetAmount[];
  /** A confirmed setup (mode or cadence) change. */
  confirm: boolean;
  /** Appended to "Proposal #N" in the budget history. */
  reason: string;
}

export interface BudgetPayload {
  steps: BudgetStep[];
}

/** A native workgroup, with the board columns it starts with and its leads. */
export interface WorkgroupPayload {
  workgroup: { name: string; description: string; leads: string[] };
  columns: readonly { name: string; position: number; marks_payable: boolean; marks_paid: boolean }[];
}

/** A task on an app board, placed in its first column that is neither payable nor paid. */
export interface TaskPayload {
  task: {
    workgroupId: string;
    /** tasks.amounts: ticker -> display-unit amount. */
    amounts: Record<string, string>;
    /** tasks.bounty_lovelace, from the ADA amount; null without ADA. */
    bountyLovelace: string | null;
    /** The proposer becomes the task's assignee. */
    assignSelf: boolean;
  };
}

/** A decision carries nothing. */
export type ProposalPayload = BudgetPayload | WorkgroupPayload | TaskPayload | Record<string, never>;

export function isBudgetPayload(payload: ProposalPayload): payload is BudgetPayload {
  return Array.isArray((payload as BudgetPayload).steps);
}

export function isWorkgroupPayload(payload: ProposalPayload): payload is WorkgroupPayload {
  return typeof (payload as WorkgroupPayload).workgroup === "object" && (payload as WorkgroupPayload).workgroup !== null;
}

export function isTaskPayload(payload: ProposalPayload): payload is TaskPayload {
  return typeof (payload as TaskPayload).task === "object" && (payload as TaskPayload).task !== null;
}

/**
 * Whether a task's bounty is above the settings' lazy-consensus cap, so it is
 * decided by the escalation method instead: an ADA amount over the cap, or
 * any other token (which lovelace cannot measure). No cap, no escalation.
 */
export function taskExceedsLazyCap(amounts: Record<string, string>, bountyLovelace: string | null, capLovelace: string | null): boolean {
  if (capLovelace === null) return false;
  if (Object.keys(amounts).some((ticker) => ticker.toLowerCase() !== "ada")) return true;
  return BigInt(bountyLovelace ?? "0") > BigInt(capLovelace);
}

export interface BudgetOwnerRef {
  workgroupId: string | null;
  treasuryId: string | null;
}

/** A budget the proposal changes and the revision it was made against. */
export interface BudgetOwnerBase extends BudgetOwnerRef {
  baseRevision: number;
}

/** Budget saves in one proposal, the worksheet's limit on tokens per owner aside. */
export const MAX_BUDGET_STEPS = 50;

/** budget_owner_key in SQL. */
export function budgetOwnerKey(ref: BudgetOwnerRef): string {
  return ref.workgroupId ? `w:${ref.workgroupId}` : `t:${ref.treasuryId}`;
}

/**
 * The owners of a list of budget saves, in first-seen order, each with the
 * revision its first save expects: the base the proposal is made against.
 */
export function budgetOwnersOf(
  saves: readonly { workgroupId?: string | null; treasuryId?: string | null; expectedRevision: number }[],
): BudgetOwnerBase[] {
  const owners = new Map<string, BudgetOwnerBase>();
  for (const save of saves) {
    const ref = { workgroupId: save.workgroupId ?? null, treasuryId: save.treasuryId ?? null };
    const key = budgetOwnerKey(ref);
    if (!owners.has(key)) owners.set(key, { ...ref, baseRevision: save.expectedRevision });
  }
  return [...owners.values()];
}

/**
 * The first setup change ("YYYY-MM") that would start before the month voting
 * can end in: past periods cannot switch setup, so it would fail when applied.
 */
export function switchStartsTooEarly(
  steps: readonly Pick<BudgetStep, "confirm" | "startsOn">[],
  votingEndsAt: Date,
): string | null {
  const endMonth = votingEndsAt.toISOString().slice(0, 7);
  return steps.find((step) => step.confirm && step.startsOn.slice(0, 7) < endMonth)?.startsOn.slice(0, 7) ?? null;
}

/**
 * Rebuild the create-API budget saves from a proposal's stored steps, using
 * each owner's current base revision (from its open proposal_budget_owners
 * row, or a fresh load). Used when revising a budget proposal without the
 * Budgets worksheet (0068).
 */
export function savesFromBudgetSteps(
  steps: readonly BudgetStep[],
  revisions: ReadonlyMap<string, number>,
): {
  workgroupId?: string;
  treasuryId?: string;
  budgetMonth: null;
  budgetCadence: BudgetCadence;
  budgets: { cadence: BudgetCadence; unit: string; amount: string }[];
  expectedRevision: number;
  mode: BudgetMode;
  startsOn: string;
  confirmTransition: boolean;
  reason: string;
}[] {
  return steps.map((step) => {
    const ref = { workgroupId: step.workgroupId, treasuryId: step.treasuryId };
    return {
      ...(step.workgroupId ? { workgroupId: step.workgroupId } : { treasuryId: step.treasuryId! }),
      budgetMonth: null,
      budgetCadence: step.cadence,
      budgets: step.amounts.map((a) => ({ cadence: step.cadence, unit: a.unit, amount: a.amount })),
      expectedRevision: revisions.get(budgetOwnerKey(ref)) ?? 0,
      mode: step.mode,
      startsOn: step.startsOn.slice(0, 7),
      confirmTransition: step.confirm,
      reason: step.reason,
    };
  });
}
