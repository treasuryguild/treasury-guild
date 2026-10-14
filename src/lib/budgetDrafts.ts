import type { BudgetSummary } from "@/lib/api/types";
import { formatQuantity, scaleDecimal, type AssetDef } from "@/lib/assets";
import type { BudgetCadence } from "@/lib/budgets";
import type { BudgetMode } from "@/lib/budgetSetups";

export interface BudgetDraftRow {
  /** `${unit}:${month}` — one row per token per period cell. */
  key: string;
  asset: AssetDef;
  /** First month of the period this row belongs to, "YYYY-MM". */
  month: string;
  amount: string;
  cadence: BudgetCadence;
  original: { amount: string; cadence: BudgetCadence } | null;
  persisted: boolean;
  removed: boolean;
  copied: boolean;
  source: BudgetSummary | null;
}

export function draftRowKey(unit: string, month: string): string {
  return `${unit}:${month}`;
}

/**
 * Draft rows for one period cell. `month` is the cell's period start (null
 * in the recurring view, where `referenceMonth` keys the rows instead).
 */
export function budgetDraftRows(
  budgets: BudgetSummary[], month: string | null, periodCadence: BudgetCadence = "monthly", referenceMonth = month ?? "",
): BudgetDraftRow[] {
  return budgets.map((budget) => {
    const amount = formatQuantity(BigInt(budget.amount), budget.decimals);
    const cadence = month ? periodCadence : budget.cadence;
    const rowMonth = month ?? referenceMonth;
    return {
      key: draftRowKey(budget.unit, rowMonth),
      asset: { unit: budget.unit, fieldName: budget.assetLabel, decimals: budget.decimals },
      month: rowMonth,
      amount,
      cadence,
      original: { amount, cadence },
      persisted: budget.budgetMonth === month && (!month || budget.cadence === periodCadence),
      removed: false,
      copied: false,
      source: budget,
    };
  });
}

/** A freshly added token cell nobody typed in: not a change, never saved. */
export function budgetRowBlank(row: BudgetDraftRow): boolean {
  return !row.original && !row.persisted && !row.copied && !row.removed && row.amount.trim() === "";
}

export function budgetRowChanged(row: BudgetDraftRow): boolean {
  if (budgetRowBlank(row)) return false;
  if (row.removed) return row.persisted || !!row.original;
  if (!row.original || row.copied || row.cadence !== row.original.cadence) return true;
  try {
    return scaleDecimal(row.amount, row.asset.decimals) !==
      scaleDecimal(row.original.amount, row.asset.decimals);
  } catch {
    return row.amount !== row.original.amount;
  }
}

/** Saving a dated plan includes all unchanged defaults for that frequency. */
export function budgetRowNeedsSave(row: BudgetDraftRow, datedPlan = false, cadence: BudgetCadence = "monthly"): boolean {
  return budgetRowChanged(row) || (datedPlan && !row.removed && !row.persisted && !budgetRowBlank(row) &&
    row.source?.cadence === cadence);
}

export function budgetRowError(row: BudgetDraftRow, datedPlan = false, cadence: BudgetCadence = "monthly"): string | null {
  if (row.removed || !budgetRowNeedsSave(row, datedPlan, cadence)) return null;
  try {
    const amount = scaleDecimal(row.amount, row.asset.decimals);
    if (amount <= 0n) return "Enter an amount greater than zero.";
    if (amount > 9223372036854775807n) return "This amount is too large.";
    return null;
  } catch {
    return `Enter a positive number with up to ${row.asset.decimals} decimal places.`;
  }
}

/** A plan includes unchanged defaults alongside edited allocations of its frequency. */
export function budgetDraftPayload(rows: BudgetDraftRow[], datedPlan = false, cadence: BudgetCadence = "monthly") {
  return rows.filter((row) => !row.removed && (row.persisted || budgetRowNeedsSave(row, datedPlan, cadence)))
    .map((row) => ({
      unit: row.asset.unit,
      cadence: row.cadence,
      amount: scaleDecimal(row.amount, row.asset.decimals).toString(),
    }));
}

/** Keep a successful save clean even if another project or the refresh fails. */
export function acceptBudgetDraft(rows: BudgetDraftRow[], datedPlan = false, cadence: BudgetCadence = "monthly"): BudgetDraftRow[] {
  return rows.filter((row) => !row.removed && !budgetRowBlank(row)).map((row) => ({
    ...row,
    persisted: row.persisted || budgetRowNeedsSave(row, datedPlan, cadence),
    original: { amount: row.amount, cadence: row.cadence },
    copied: false,
  }));
}

/**
 * Copy only matching frequencies; a quarterly ceiling is not a monthly
 * allocation. With `targetMonth`, only the rows of that period cell are
 * filled, from the source budgets whose period starts at `sourceMonth`.
 */
export function copyPeriodBudgets(
  current: BudgetDraftRow[], source: BudgetSummary[], cadence: BudgetCadence = "monthly",
  targetMonth?: string, sourceMonth?: string,
): BudgetDraftRow[] {
  const result = [...current];
  const matching = source.filter((item) => item.cadence === cadence &&
    (!sourceMonth || item.periodStart.slice(0, 7) === sourceMonth));
  for (const budget of matching) {
    const index = result.findIndex((row) => row.asset.unit === budget.unit && (!targetMonth || row.month === targetMonth));
    const amount = formatQuantity(BigInt(budget.amount), budget.decimals);
    if (index >= 0) {
      const row = result[index]!;
      // Existing dated allocations and the user's edits take precedence.
      if (row.persisted || budgetRowChanged(row)) continue;
      result[index] = { ...row, amount, copied: true, removed: false };
    } else {
      const month = targetMonth ?? current[0]?.month ?? "";
      result.push({
        key: draftRowKey(budget.unit, month),
        asset: { unit: budget.unit, fieldName: budget.assetLabel, decimals: budget.decimals },
        month,
        amount,
        cadence,
        original: null,
        persisted: false,
        removed: false,
        copied: true,
        source: null,
      });
    }
  }
  return result;
}

/** One budget save the worksheet makes for a project: a period (or the recurring amounts) and its rows. */
export interface BudgetSavePlan {
  month: string;
  rows: BudgetDraftRow[];
  mode: BudgetMode;
  cadence: BudgetCadence;
}

/**
 * The /api/budgets bodies for one project's plans, in order, without the
 * revision (the direct save chains it; a budget proposal sends the base for
 * every save). A staged setup change rides the first save.
 */
export function budgetSaveBodies(
  owner: { workgroupId: string } | { treasuryId: string },
  plans: readonly BudgetSavePlan[],
  config: { startsOn: string; reason: string },
  staged: boolean,
) {
  return plans.map((plan, index) => {
    const first = index === 0;
    return {
      ...owner,
      budgetMonth: plan.mode === "recurring" ? null : plan.month,
      budgetCadence: plan.cadence,
      mode: plan.mode,
      startsOn: plan.mode === "recurring" || (first && staged) ? config.startsOn : plan.month,
      confirmTransition: first && staged,
      reason: first ? config.reason : "",
      budgets: budgetDraftPayload(plan.rows, plan.mode !== "recurring", plan.cadence),
    };
  });
}
