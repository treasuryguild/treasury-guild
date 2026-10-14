// The spending check as the build routes run it: only while the community's
// budget kind is on, against the budgets in force (`budgetInForce`) and what
// is already spent (db/spendCheck.ts), then warn or refuse as the community
// chose. Warn returns the problems for the transaction row; refuse throws
// the build error with them.
import "server-only";

import { budgetInForce, type BudgetInForce } from "@/lib/budgetSetups";
import { ProposalKind } from "@/lib/constants";
import type { BudgetSources } from "@/lib/db/budgetSetups";
import { loadGovernanceCommunitySettings, loadGovernanceSettings } from "@/lib/db/governance";
import { loadSpentForTargets, type SpentTarget } from "@/lib/db/spendCheck";
import { BadRequestError } from "@/lib/errors";
import { SpendCheckMode } from "./rules";
import { spendCheck, spendKey, spendProblemText, type SpendLine, type SpendProblem } from "./spendCheck";

export const SPEND_CHECK_FAILED = "This spend does not fit the voted budgets";

export interface SpendGuardLine extends SpendLine {
  ownerType: "workgroup" | "treasury";
  ownerId: string;
}

/** The budget in force per (owner, period) of these lines, from the loaded sources. */
export function budgetsForLines(
  lines: readonly SpendGuardLine[], sources: BudgetSources,
): Map<string, BudgetInForce | null> {
  const budgets = new Map<string, BudgetInForce | null>();
  for (const line of lines) {
    const key = spendKey(line.ownerKey, line.periodMonth);
    if (budgets.has(key)) continue;
    budgets.set(key, budgetInForce(sources.setups.get(line.ownerKey) ?? [], sources.plans, line.periodMonth));
  }
  return budgets;
}

/**
 * Run the check for a build. Returns the problems to store (warn mode, or
 * none); throws the build error in refuse mode. Nothing runs while the
 * community's budget kind is off.
 */
export async function guardSpend(
  communityId: string, lines: readonly SpendGuardLine[], sources: BudgetSources,
): Promise<SpendProblem[]> {
  if (lines.length === 0) return [];
  const budgetKind = await loadGovernanceSettings(communityId, ProposalKind.Budget);
  if (!budgetKind.enabled) return [];

  const budgets = budgetsForLines(lines, sources);
  const targets = new Map<string, SpentTarget>();
  for (const line of lines) {
    const key = spendKey(line.ownerKey, line.periodMonth);
    const budget = budgets.get(key);
    if (!budget || targets.has(key)) continue;
    targets.set(key, {
      ownerKey: line.ownerKey, ownerType: line.ownerType, ownerId: line.ownerId,
      // The line's month is already aligned (taskBudgetPeriod); the spent map is keyed by it.
      periodMonth: line.periodMonth, cadence: budget.cadence,
    });
  }
  const [spent, community] = await Promise.all([
    loadSpentForTargets(communityId, [...targets.values()]),
    loadGovernanceCommunitySettings(communityId),
  ]);
  const problems = spendCheck({ lines, budgets, spent });
  if (problems.length > 0 && community.spendCheck === SpendCheckMode.Refuse) {
    throw new BadRequestError(SPEND_CHECK_FAILED, { problems: problems.map(spendProblemText) });
  }
  return problems;
}
