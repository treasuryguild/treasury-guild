// What a proposal changes when it passes, in plain lines: for the proposal
// page's budget card and the agent API. Client-safe.
import { budgetAmountsText } from "@/lib/budgetSetups";
import { periodLabel } from "@/lib/budgets";
import type { ProposalRow } from "@/lib/db/types";
import { isBudgetPayload, isTaskPayload, isWorkgroupPayload, type BudgetStep } from "./payload";

/** "Recurring monthly budget from 2026-09: 2,500 ADA" / "Q4 2026: 900 ADA". */
export function budgetStepText(step: BudgetStep): string {
  const month = step.startsOn.slice(0, 7);
  const amounts = budgetAmountsText(step.amounts, "no allocations");
  if (step.mode === "recurring") return `Recurring ${step.cadence} budget from ${month}: ${amounts}`;
  return `${periodLabel(month, step.cadence)}: ${amounts}`;
}

/** Names for the ids and wallets a payload refers to. */
export interface ChangeNames {
  /** A workgroup's or treasury's name by id. */
  owner: (id: string) => string | undefined;
  /** A member's display name by wallet. */
  member: (wallet: string) => string;
}

export function proposalChangeLines(p: Pick<ProposalRow, "payload" | "proposer">, names: ChangeNames): string[] {
  const { payload } = p;
  if (isBudgetPayload(payload)) {
    return payload.steps.map((step) => {
      const id = (step.workgroupId ?? step.treasuryId)!;
      const owner = names.owner(id) ?? "a deleted project";
      return `${step.treasuryId ? `Treasury ${owner}` : owner}: ${budgetStepText(step)}${step.confirm ? " (changes the budget setup)" : ""}`;
    });
  }
  if (isWorkgroupPayload(payload)) {
    const leads = payload.workgroup.leads.map(names.member).join(", ") || "none";
    return [`Creates the workgroup ${payload.workgroup.name} (app board), led by ${leads}`];
  }
  if (isTaskPayload(payload)) {
    const bounty = Object.entries(payload.task.amounts).map(([ticker, amount]) => `${amount} ${ticker}`).join(" + ") || "no bounty";
    const board = names.owner(payload.task.workgroupId) ?? "a deleted workgroup";
    return [`Adds the task to ${board}, paying ${bounty} per assignee${payload.task.assignSelf ? `, assigned to ${names.member(p.proposer)}` : ""}`];
  }
  return [];
}
