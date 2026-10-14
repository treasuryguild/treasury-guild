// Which treasury pays a workgroup's tasks in a given budget period. The one
// home for reading the dated `workgroup_treasury_assignments` timeline; the
// SQL twin is `workgroup_routing_period` / `set_workgroup_treasury`
// (migration 0035). Client-safe, no I/O.

import { alignBudgetMonth, currentBudgetMonth, shiftMonth, type BudgetCadence } from "@/lib/budgets";
import { cadenceAt, type BudgetSetup } from "@/lib/budgetSetups";

export interface TreasuryAssignment {
  /** Null = any community wallet. */
  treasury_id: string | null;
  /** "YYYY-MM-DD", always the first of a month. */
  starts_on: string;
}

/**
 * The treasury routed for the period starting at `month` ("YYYY-MM"): the
 * assignment with the latest start on or before it. Null when the timeline is
 * empty or that assignment says "any wallet".
 */
export function routedTreasuryAt(
  assignments: readonly TreasuryAssignment[],
  month: string,
): string | null {
  const day = `${month}-01`;
  let active: TreasuryAssignment | undefined;
  for (const assignment of assignments) {
    if (assignment.starts_on > day) continue;
    if (!active || assignment.starts_on > active.starts_on) active = assignment;
  }
  return active?.treasury_id ?? null;
}

export interface RoutingPeriod {
  cadence: BudgetCadence;
  /** First month of the period containing today, "YYYY-MM". */
  currentStart: string;
  /** First month of the following period, "YYYY-MM". */
  nextStart: string;
}

/**
 * The budget period a wallet change would start in, from the workgroup's
 * setup in force today (no setup = monthly). Mirrors the SQL so the dialog
 * can label its choices before the server answers.
 */
export function routingPeriod(
  setups: readonly Pick<BudgetSetup, "starts_on" | "cadence">[],
  today: string = currentBudgetMonth(),
): RoutingPeriod {
  const cadence = cadenceAt(setups, today) ?? "monthly";
  const currentStart = alignBudgetMonth(today, cadence);
  return { cadence, currentStart, nextStart: shiftMonth(currentStart, cadence === "quarterly" ? 3 : 1) };
}
