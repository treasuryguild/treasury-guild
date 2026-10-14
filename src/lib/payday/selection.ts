// Pure helpers for which payable tasks can be selected and paid from where.

import { everyAssigneeHasWallet } from "@/lib/assignees";
import { ADA_ASSET, formatQuantity } from "@/lib/assets";
import { currentBudgetMonth } from "@/lib/budgets";
import { taskBudgetPeriod, type BudgetSetup } from "@/lib/budgetSetups";
import { shortUnit } from "@/lib/format";
import { routedTreasuryAt, type TreasuryAssignment } from "@/lib/workgroupRouting";
import type { PayableTask } from "./types";

/**
 * Human-unit amounts per ticker (raw field values). Legacy rows without
 * `amounts` fall back to bounty_lovelace rendered exactly as ADA.
 */
export function taskAmounts(t: PayableTask): Record<string, string> {
  if (t.amounts && Object.keys(t.amounts).length > 0) return t.amounts;
  if (t.bounty_lovelace) {
    return {
      [ADA_ASSET.fieldName]: formatQuantity(BigInt(t.bounty_lovelace), ADA_ASSET.decimals),
    };
  }
  return {};
}

export function hasBounty(t: PayableTask): boolean {
  return Object.keys(taskAmounts(t)).length > 0;
}

/** Whether every assignee can be paid: ≥1 assignee, all with wallets. */
export function isPayable(t: PayableTask): boolean {
  return everyAssigneeHasWallet(t.task_assignees);
}

/** Buildable: every assignee has a wallet and there is some amount. */
export function isReady(t: PayableTask): boolean {
  return isPayable(t) && hasBounty(t);
}

/** The dated routing and budget setups Payday resolves a task's wallet with. */
export interface RoutingContext {
  assignments: ReadonlyMap<string, readonly TreasuryAssignment[]>;
  setups: ReadonlyMap<string, readonly Pick<BudgetSetup, "starts_on" | "cadence">[]>;
}

/**
 * The treasury a task must be paid from, or null when any wallet may pay it.
 * With a routing context the wallet is the one in force for the task's own
 * budget period (a task from before a scheduled wallet change stays with its
 * period's wallet, as build-payout checks); without one, the workgroup's
 * current wallet is the hint.
 */
export function taskRoute(t: PayableTask, routing?: RoutingContext): string | null {
  const assignments = routing?.assignments.get(t.workgroup_id);
  if (!assignments) return t.workgroup.treasury_id;
  const period = taskBudgetPeriod(t.budget_month, routing!.setups.get(t.workgroup_id) ?? [], currentBudgetMonth());
  return routedTreasuryAt(assignments, period.month);
}

/** The other treasury a task's workgroup is routed to, if not this one. */
export function routedElsewhere(t: PayableTask, treasuryId: string, routing?: RoutingContext): string | null {
  if (!treasuryId) return null;
  const route = taskRoute(t, routing);
  return route && route !== treasuryId ? route : null;
}

/**
 * The payout selection: every ready task this treasury may pay, minus the
 * ones the user unticked. Derived rather than stored, so a reload after an
 * edit keeps the user's choices and selects a task the edit made ready.
 */
export function deriveSelection(
  tasks: PayableTask[],
  treasuryId: string,
  optedOut: ReadonlySet<string>,
  routing?: RoutingContext,
): Set<string> {
  return new Set(
    tasks
      .filter((t) => isReady(t) && !optedOut.has(t.id) && !routedElsewhere(t, treasuryId, routing))
      .map((t) => t.id),
  );
}

export function tokenLabel(t: { ticker: string | null; name: string | null; unit: string }): string {
  return t.ticker ?? t.name ?? shortUnit(t.unit);
}
