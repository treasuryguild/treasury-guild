// "Fund this budget" (docs/onchain-anchoring-estimate.md, phase 5): from an
// applied budget proposal, a Payments link that transfers one period's voted
// amounts to the treasury the workgroup is routed to, citing the proposal.
// Shown only where the transfer is unambiguous: the workgroup is routed to
// one treasury for that period and the community has another to pay from.
// Pure and client-safe.
import { formatQuantity } from "@/lib/assets";
import { alignBudgetMonth } from "@/lib/budgets";
import { ExecutionState, ProposalState } from "@/lib/constants";
import type { ProposalRow } from "@/lib/db/types";
import type { PaymentPrefill } from "@/lib/payments/prefill";
import { routedTreasuryAt, type TreasuryAssignment } from "@/lib/workgroupRouting";
import type { BudgetStep } from "./payload";

/** The proposal passed and its budget changes were applied: the budgets it names are the ones in force. */
export function isAppliedBudgetProposal(p: Pick<ProposalRow, "state" | "execution_state">): boolean {
  return p.state === ProposalState.Passed && p.execution_state === ExecutionState.Applied;
}

/**
 * The period a step is funded for: a single-period step is its own period;
 * a recurring one is funded for the current period, or its first period
 * when that is still ahead. Aligned to the step's cadence ("YYYY-MM").
 */
export function fundingPeriod(step: Pick<BudgetStep, "mode" | "cadence" | "startsOn">, today: string): string {
  const start = alignBudgetMonth(step.startsOn.slice(0, 7), step.cadence);
  if (step.mode !== "recurring") return start;
  const current = alignBudgetMonth(today.slice(0, 7), step.cadence);
  return current > start ? current : start;
}

/**
 * The prefill of a "Fund this budget" link for one step, or null when it is
 * not offered: the step is not a workgroup's, the workgroup is routed to no
 * one treasury for the period ("any wallet"), the community has no other
 * treasury to pay from, or the step allocates nothing.
 */
export function fundBudgetPrefill(
  step: BudgetStep,
  proposal: Pick<ProposalRow, "id" | "state" | "execution_state">,
  assignments: ReadonlyMap<string, readonly TreasuryAssignment[]>,
  treasuryCount: number,
  today: string,
): PaymentPrefill | null {
  if (!isAppliedBudgetProposal(proposal) || !step.workgroupId || treasuryCount < 2) return null;
  const month = fundingPeriod(step, today);
  const treasuryId = routedTreasuryAt(assignments.get(step.workgroupId) ?? [], month);
  if (!treasuryId) return null;
  const amounts = Object.fromEntries(step.amounts
    .filter((a) => BigInt(a.amount) > 0n)
    .map((a) => [a.unit, formatQuantity(BigInt(a.amount), a.decimals)]));
  if (Object.keys(amounts).length === 0) return null;
  return { treasuryId, month, proposalId: proposal.id, amounts };
}
