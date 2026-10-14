// The spending check: does a spend the app is about to build fit the budgets
// the community voted? Pure and client-safe; the build routes run it with
// the budgets in force and what the Dashboard already counts as spent, and
// store or refuse on its problems (the community's `spend_check` setting).
// The co-signer of a later phase runs the same function.
//
// Transfers between a community's treasuries are not spends and never
// become lines. Amounts are whole base units per unit, compared as BigInt.

import { budgetPeriodCode, type BudgetCadence } from "@/lib/budgets";
import type { BudgetInForce } from "@/lib/budgetSetups";
import { formatUnits } from "@/lib/format";

export const SpendProblemCode = {
  /** No budget in force for the owner and period. */
  NoBudget: "no_budget",
  /** The spend takes the period over its budget for one asset. */
  OverBudget: "over_budget",
  /** The budget in force was saved directly, not set by a proposal. */
  BudgetNotVoted: "budget_not_voted",
} as const;
export type SpendProblemCode = (typeof SpendProblemCode)[keyof typeof SpendProblemCode];

/** One asset of one spend, charged to a budget owner's period. */
export interface SpendLine {
  /** `w:<workgroupId>` or `t:<treasuryId>` (budget_owner_key). */
  ownerKey: string;
  ownerName: string;
  /** The period's first month ("YYYY-MM"), quarter-aligned for a quarterly owner. */
  periodMonth: string;
  unit: string;
  /** Base units. */
  amount: bigint;
  ticker: string;
  decimals: number;
}

/** What is already spent against one owner's period, per unit (base units). */
export interface SpentAmount {
  ownerKey: string;
  periodMonth: string;
  unit: string;
  amount: bigint;
}

/** One problem, with every number as a decimal string of base units so it stores as JSON. */
export interface SpendProblem {
  code: SpendProblemCode;
  ownerKey: string;
  ownerName: string;
  /** The period as written on-chain: "YYYY-MM" or "YYYY-Qn". */
  period: string;
  unit?: string;
  ticker?: string;
  decimals?: number;
  /** This spend's amount of the asset. */
  amount?: string;
  /** The period's budget of the asset ("0" when the budget lists no such asset). */
  budget?: string;
  /** Already spent before this spend. */
  spent?: string;
}

export interface SpendCheckInput {
  lines: readonly SpendLine[];
  /** The budget in force per owner and period, null when there is none. */
  budgets: ReadonlyMap<string, BudgetInForce | null>;
  spent: readonly SpentAmount[];
}

export function spendKey(ownerKey: string, periodMonth: string): string {
  return `${ownerKey}|${periodMonth}`;
}

function periodCode(month: string, cadence: BudgetCadence | null): string {
  return budgetPeriodCode(month, cadence);
}

/**
 * The problems of a spend against the voted budgets, grouped by owner and
 * period: one `no_budget` or `budget_not_voted` per group, then one
 * `over_budget` per asset that would end over its budget (a spend that only
 * fills the budget exactly is fine). Empty when everything fits.
 */
export function spendCheck({ lines, budgets, spent }: SpendCheckInput): SpendProblem[] {
  const problems: SpendProblem[] = [];
  const groups = new Map<string, SpendLine[]>();
  for (const line of lines) {
    const key = spendKey(line.ownerKey, line.periodMonth);
    const group = groups.get(key);
    if (group) group.push(line);
    else groups.set(key, [line]);
  }
  const spentByUnit = new Map<string, bigint>();
  for (const s of spent) {
    const key = `${spendKey(s.ownerKey, s.periodMonth)}|${s.unit}`;
    spentByUnit.set(key, (spentByUnit.get(key) ?? 0n) + s.amount);
  }

  for (const [key, group] of groups) {
    const first = group[0]!;
    const budget = budgets.get(key) ?? null;
    const base = { ownerKey: first.ownerKey, ownerName: first.ownerName };
    if (!budget) {
      problems.push({ code: SpendProblemCode.NoBudget, ...base, period: periodCode(first.periodMonth, null) });
      continue;
    }
    const period = periodCode(budget.periodMonth, budget.cadence);
    if (!budget.proposalId) {
      problems.push({ code: SpendProblemCode.BudgetNotVoted, ...base, period });
    }
    const byUnit = new Map<string, SpendLine & { total: bigint }>();
    for (const line of group) {
      const entry = byUnit.get(line.unit);
      if (entry) entry.total += line.amount;
      else byUnit.set(line.unit, { ...line, total: line.amount });
    }
    for (const [unit, line] of byUnit) {
      const allowed = BigInt(budget.amounts.find((a) => a.unit === unit)?.amount ?? "0");
      const already = spentByUnit.get(`${key}|${unit}`) ?? 0n;
      if (already + line.total > allowed) {
        problems.push({
          code: SpendProblemCode.OverBudget, ...base, period, unit, ticker: line.ticker, decimals: line.decimals,
          amount: line.total.toString(), budget: allowed.toString(), spent: already.toString(),
        });
      }
    }
  }
  return problems;
}

/** One sentence per problem, for the build error and the transaction page. */
export function spendProblemText(p: SpendProblem): string {
  switch (p.code) {
    case SpendProblemCode.NoBudget:
      return `${p.ownerName} has no budget for ${p.period}.`;
    case SpendProblemCode.BudgetNotVoted:
      return `The ${p.period} budget of ${p.ownerName} was set directly, not by a proposal.`;
    case SpendProblemCode.OverBudget: {
      const fmt = (v: string) => formatUnits(v, p.decimals ?? 0, p.ticker);
      return `${p.ownerName} would go over its ${p.period} budget of ${fmt(p.budget ?? "0")}: ` +
        `${fmt(p.spent ?? "0")} already spent, ${fmt(p.amount ?? "0")} in this transaction.`;
    }
  }
}
