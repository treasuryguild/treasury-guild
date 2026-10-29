// Calendar-period and asset-option helpers shared by the budget API and dashboard.

import type { WalletTokenWire } from "@/lib/api/types";
import { ADA_ASSET, tokenFallbackLabel, type AssetDef } from "@/lib/assets";
import { assetNameFromUnit } from "@/lib/cardano/assetInfo";
import { MAX_TICKER_BYTES, truncateUtf8 } from "@/lib/cardano/metadata";

export const BudgetCadence = {
  Monthly: "monthly",
  Quarterly: "quarterly",
} as const;

export type BudgetCadence =
  (typeof BudgetCadence)[keyof typeof BudgetCadence];

export interface BudgetPeriod {
  start: string;
  end: string;
  label: string;
}

/** The UTC calendar month of an instant, a date string or a timestamp, "YYYY-MM". */
export function monthOf(value: string | Date): string {
  return (typeof value === "string" ? new Date(value) : value).toISOString().slice(0, 7);
}

/** UTC midnight on the first day of a "YYYY-MM" month. */
export function monthDate(month: string): Date {
  return new Date(`${month}-01T00:00:00Z`);
}

export function currentBudgetMonth(): string {
  return monthOf(new Date());
}

/**
 * True when `month` ("YYYY-MM") is strictly after the current budget month.
 * Used to refuse spend attributed to a future period (a recurring budget
 * would otherwise look empty and give unlimited headroom).
 */
export function isFutureBudgetMonth(month: string, now: string = currentBudgetMonth()): boolean {
  return month > now;
}

/** A budget month, "YYYY-MM". */
export const BUDGET_MONTH_RE = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;

export function budgetMonthFromQuery(value: unknown): string {
  return typeof value === "string" && BUDGET_MONTH_RE.test(value)
    ? value : currentBudgetMonth();
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** First month of the quarter containing `month` ("YYYY-MM" in, "YYYY-MM" out). */
export function quarterStartMonth(month: string): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  const index = Number(m[2]) - 1;
  const start = Math.floor(index / 3) * 3 + 1;
  return `${m[1]}-${String(start).padStart(2, "0")}`;
}

/** Shift a "YYYY-MM" month by `count` months. */
export function shiftMonth(month: string, count: number): string {
  const date = monthDate(month);
  date.setUTCMonth(date.getUTCMonth() + count);
  return monthOf(date);
}

/** `month` when it starts a quarter, else the first month of the next quarter. */
export function nextQuarterStart(month: string): string {
  const start = quarterStartMonth(month);
  return start === month ? month : shiftMonth(start, 3);
}

/** The three months of the quarter containing `month`, as "YYYY-MM". */
export function quarterMonths(month: string): string[] {
  const start = quarterStartMonth(month);
  return [start, shiftMonth(start, 1), shiftMonth(start, 2)];
}

/** Short month label for a column header ("2026-07" → "Jul 2026"). */
export function shortMonthLabel(month: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" })
    .format(monthDate(month));
}

/** Short quarter label ("2026-08" → "Q3 2026"). */
export function quarterLabel(month: string): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  return `Q${Math.floor((Number(m[2]) - 1) / 3) + 1} ${m[1]}`;
}

/** Short label of the period starting at `month`: "Jul 2026", or "Q3 2026" when budgeted by quarter. */
export function periodLabel(month: string, cadence: BudgetCadence | null): string {
  return cadence === BudgetCadence.Quarterly ? quarterLabel(month) : shortMonthLabel(month);
}

/** The quarter containing `month` as "YYYY-Qn" ("2026-05" → "2026-Q2"). */
export function quarterCode(month: string): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  return `${m[1]}-Q${Math.floor((Number(m[2]) - 1) / 3) + 1}`;
}

/**
 * The month a task is stored under for `cadence`: a quarterly workgroup keeps
 * every task of a quarter on the quarter's first month.
 */
export function alignBudgetMonth(month: string, cadence: BudgetCadence | null): string {
  return cadence === BudgetCadence.Quarterly ? quarterStartMonth(month) : month;
}

/**
 * The period written on-chain for a task in `month`: "YYYY-MM" for a
 * workgroup budgeted by month, "YYYY-Qn" for one budgeted by quarter. Makes
 * the label-190001 record self-describing without the database.
 */
export function budgetPeriodCode(month: string, cadence: BudgetCadence | null): string {
  return cadence === BudgetCadence.Quarterly ? quarterCode(month) : month;
}

/**
 * Inverse of `budgetPeriodCode`, for a period read back from the chain: the
 * day-1 date a task or payment is stored under ("2026-09" → "2026-09-01",
 * "2026-Q3" → "2026-07-01"). Null for anything else.
 */
export function budgetMonthFromPeriodCode(code: string): string | null {
  const q = /^([1-9]\d{3})-Q([1-4])$/.exec(code);
  if (q) return `${q[1]}-${String((Number(q[2]) - 1) * 3 + 1).padStart(2, "0")}-01`;
  return BUDGET_MONTH_RE.test(code) ? `${code}-01` : null;
}

/** First month of the period containing today for `cadence` ("YYYY-MM"). */
export function currentPeriodStart(cadence: BudgetCadence | null): string {
  return alignBudgetMonth(currentBudgetMonth(), cadence);
}

/**
 * Whether the period starting at `month` has already ended for `cadence`:
 * a quarter is current until its last month is over, so editing it
 * mid-quarter is not a historical correction. Mirrors `save_budget_setup`.
 */
export function isPastPeriod(month: string, cadence: BudgetCadence | null): boolean {
  return alignBudgetMonth(month, cadence) < currentPeriodStart(cadence);
}

export function inBudgetPeriod(timestamp: string, start: string, end: string): boolean {
  const time = Date.parse(timestamp);
  return time >= Date.parse(start) && time < Date.parse(end);
}

/**
 * The instant a payout counts against a budget: the task's assigned budget
 * month (a "YYYY-MM-DD" date, parsed as UTC midnight) when it has one, else
 * when the paying transaction was submitted — the rule for tasks paid
 * before budget months existed.
 */
export function budgetAttributionTime(payout: {
  budgetMonth: string | null;
  submittedAt: string | null;
  createdAt: string;
}): string {
  return payout.budgetMonth ?? payout.submittedAt ?? payout.createdAt;
}

/** A dated allocation overrides only the same workgroup/token's default. */
export function effectiveBudgets<T extends {
  workgroup_id: string;
  unit: string;
  budget_month: string | null;
  cadence: BudgetCadence;
}>(budgets: T[], month: string, cadence: BudgetCadence = "monthly"): T[] {
  const scoped = budgets.filter((budget) => budget.cadence === cadence);
  const dated = scoped.filter((budget) => budget.budget_month === `${month}-01`);
  const keys = new Set(dated.map((budget) => `${budget.workgroup_id}:${budget.unit}`));
  return [
    ...dated,
    ...scoped.filter((budget) => budget.budget_month === null &&
      !keys.has(`${budget.workgroup_id}:${budget.unit}`)),
  ];
}

function isoDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString();
}

/** Current calendar month/quarter in UTC; `end` is exclusive. */
export function budgetPeriod(
  cadence: BudgetCadence,
  now = new Date(),
): BudgetPeriod {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (cadence === BudgetCadence.Monthly) {
    return {
      start: isoDate(year, month, 1),
      end: isoDate(year, month + 1, 1),
      label: new Intl.DateTimeFormat("en", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(year, month, 1))),
    };
  }

  const quarterStart = Math.floor(month / 3) * 3;
  const start = isoDate(year, quarterStart, 1);
  return {
    start,
    end: isoDate(year, quarterStart + 3, 1),
    label: quarterLabel(monthOf(start)),
  };
}

export function budgetUsagePercent(spent: bigint, amount: bigint): number {
  if (amount <= 0n) return 0;
  const basisPoints = (spent * 10_000n) / amount;
  return Math.max(0, Math.min(100, Number(basisPoints) / 100));
}

/** Stable, compact label for a treasury token whose metadata may be sparse. */
export function budgetTokenLabel(
  token: Pick<WalletTokenWire, "unit" | "ticker" | "name">,
): string {
  const metadataLabel =
    token.ticker?.trim() || token.name?.trim() || assetNameFromUnit(token.unit);
  // community_assets and budget labels intentionally share the ticker cap;
  // truncation never splits a code point.
  const label = metadataLabel ? truncateUtf8(metadataLabel, MAX_TICKER_BYTES) : "";
  return label || tokenFallbackLabel(token.unit);
}

/** ADA + known assets + tokens currently held by the selected treasury. */
export function budgetAssetOptions(
  known: AssetDef[],
  walletTokens: WalletTokenWire[],
): AssetDef[] {
  const byUnit = new Map<string, AssetDef>([[ADA_ASSET.unit, ADA_ASSET]]);
  for (const asset of known) byUnit.set(asset.unit, asset);
  for (const token of walletTokens) {
    byUnit.set(token.unit, {
      fieldName: budgetTokenLabel(token),
      unit: token.unit,
      decimals: token.decimals,
    });
  }
  return [...byUnit.values()];
}
