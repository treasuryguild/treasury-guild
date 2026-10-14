// Pure Dashboard logic: the trailing month window, spending attributed to
// budget periods (`spendingMonth`), its aggregation, and the rows the charts and the budget table draw from. Client-safe; the
// database loader lives in lib/db/dashboard.ts. Amounts stay exact (BigInt
// strings); a float appears only in `values`, for bar geometry.

import type {
  BudgetRefundItem,
  BudgetSpendingItem,
  BudgetSummary,
  DashboardMonth,
  DashboardPeriodStats,
  DashboardSeries,
  DashboardSpendingCell,
} from "@/lib/api/types";
import { addQuantity, formatQuantity, LOVELACE } from "@/lib/assets";
import {
  BudgetCadence, inBudgetPeriod, monthDate, monthOf, periodLabel, quarterMonths, quarterStartMonth, shiftMonth,
  type BudgetPeriod,
} from "@/lib/budgets";
import type { BudgetOwnerType } from "@/lib/budgetSetups";
import { formatUnits } from "@/lib/format";

/** A month, a quarter, or the community's whole history. */
export type DashboardView = "month" | "quarter" | "all";
/** What one bar of the time-series charts covers. */
export type DashboardBucket = "month" | "quarter";

/** Months on the time-series charts, ending at the selected period. */
export const WINDOW_MONTHS = 12;
/** Past this many months the all-time charts draw one bar per quarter. */
export const MAX_MONTH_BARS = 24;
/** Owner filter value meaning every workgroup, project and treasury. */
export const ALL_WORKGROUPS = "all";
/** Token filter value meaning one chart per token budgeted in view. */
export const BUDGETED_TOKENS = "budgeted";
/** Treasuries drawn as their own stack before the rest fold into one. */
export const MAX_TREASURY_SERIES = 4;
export const OTHER_TREASURIES = "other";

/**
 * One spend line in its budget period: a task payout charged to a workgroup,
 * a manual payment (no task) charged to the paying treasury's own budget, or
 * a line imported from a previous wallet (a history task key; its wallet id
 * stands as `treasuryId`) charged to its workgroup.
 */
export interface SeriesPayout {
  /** Null for a manual payment: spend only, never a task or contributor count. */
  taskId: string | null;
  contributorWallet: string;
  ownerType: BudgetOwnerType;
  ownerId: string;
  treasuryId: string;
  unit: string;
  amount: string;
  /** The month it draws in, "YYYY-MM" (`spendingMonth`). */
  month: string;
}

/** A reconciled refund, netted from the workgroup that was paid. */
export interface SeriesRefund {
  ownerId: string;
  treasuryId: string;
  unit: string;
  amount: string;
  createdAt: string;
}

export interface DashboardWindow {
  /** Bucket keys, oldest first: "YYYY-MM", a quarter bucket under its first month. */
  months: string[];
  /** The selected month, the three months of the selected quarter, or every bucket of all time. */
  selected: string[];
  bucket: DashboardBucket;
  /** ISO bounds of the window; `end` is exclusive. */
  start: string;
  end: string;
}

function monthStart(month: string): string {
  return monthDate(month).toISOString();
}

/** The trailing window ending at `month`, or at the last month of its quarter. */
export function dashboardWindow(month: string, view: Exclude<DashboardView, "all">): DashboardWindow {
  const selected = view === "quarter" ? quarterMonths(month) : [month];
  const last = selected[selected.length - 1]!;
  const months = Array.from({ length: WINDOW_MONTHS }, (_, index) =>
    shiftMonth(last, index - (WINDOW_MONTHS - 1)));
  return { months, selected, bucket: "month", start: monthStart(months[0]!), end: monthStart(shiftMonth(last, 1)) };
}

/**
 * The whole history from `firstMonth` (the first activity) through `nowMonth`:
 * a bar per month, or per quarter past `MAX_MONTH_BARS`. Every bucket is
 * selected, so the period counts are distinct over all time. With no activity
 * yet it is the trailing window ending now.
 */
export function allTimeWindow(firstMonth: string | null, nowMonth: string): DashboardWindow {
  if (firstMonth === null || firstMonth > nowMonth) return dashboardWindow(nowMonth, "month");
  const all: string[] = [];
  for (let month = firstMonth; month <= nowMonth; month = shiftMonth(month, 1)) all.push(month);
  const bucket: DashboardBucket = all.length > MAX_MONTH_BARS ? "quarter" : "month";
  const months = bucket === "quarter" ? [...new Set(all.map(quarterStartMonth))] : all;
  return { months, selected: months, bucket, start: monthStart(months[0]!), end: monthStart(shiftMonth(nowMonth, 1)) };
}

/** The window bucket of a "YYYY-MM" month: itself, or the first month of its quarter. */
export function monthBucket(month: string, bucket: DashboardBucket): string {
  return bucket === "quarter" ? quarterStartMonth(month) : month;
}

/** The window bucket an instant falls in: its month, or the first month of its quarter. */
export function bucketKey(iso: string, bucket: DashboardBucket): string {
  return monthBucket(monthOf(iso), bucket);
}

/**
 * The month one payout or payment draws in on the Dashboard: the month it was
 * paid, clamped into its budget period. A monthly period is its one month, so
 * a monthly task always lands in its budget month; a quarterly one (stored
 * under the quarter's first month) lands in the month it was paid when that is
 * inside the quarter, else in the quarter's first or last month, so the three
 * months of a quarter still sum exactly to what it spent. With no period set
 * (legacy rows) it is the payment month.
 */
export function spendingMonth(input: {
  budgetMonth: string | null;
  /** When the paying transaction was submitted. */
  paidAt: string;
  /** The owner's cadence in force for the budget month, null without a setup. */
  cadence: BudgetCadence | null;
}): string {
  const paid = monthOf(input.paidAt);
  if (input.budgetMonth === null) return paid;
  const month = input.budgetMonth.slice(0, 7);
  const months = input.cadence === BudgetCadence.Quarterly ? quarterMonths(month) : [month];
  const first = months[0]!;
  const last = months[months.length - 1]!;
  return paid < first ? first : paid > last ? last : paid;
}

/** Chart label of a bucket: "Jul 2026", or "Q3 2026" for a quarter. */
export function bucketLabel(key: string, bucket: DashboardBucket): string {
  return periodLabel(key, bucket === "quarter" ? BudgetCadence.Quarterly : BudgetCadence.Monthly);
}

/** A float for chart geometry only; labels come from `formatUnits`. */
export function chartNumber(amount: string | bigint, decimals: number): number {
  const value = BigInt(amount);
  const magnitude = Number(formatQuantity(value < 0n ? -value : value, decimals));
  return value < 0n ? -magnitude : magnitude;
}

interface Counts {
  contributors: Set<string>;
  tasks: Set<string>;
}
interface OwnerBucket extends Counts {
  ownerType: BudgetOwnerType;
  /** treasury -> unit -> net amount */
  spend: Map<string, Map<string, bigint>>;
}
interface MonthBucket extends Counts {
  byOwner: Map<string, OwnerBucket>;
}

function ownerIn(bucket: MonthBucket, ownerType: BudgetOwnerType, ownerId: string): OwnerBucket {
  let owner = bucket.byOwner.get(ownerId);
  if (!owner) {
    owner = { ownerType, contributors: new Set(), tasks: new Set(), spend: new Map() };
    bucket.byOwner.set(ownerId, owner);
  }
  return owner;
}

function addSpend(owner: OwnerBucket, treasuryId: string, unit: string, amount: bigint): void {
  const byUnit = owner.spend.get(treasuryId) ?? new Map<string, bigint>();
  addQuantity(byUnit, unit, amount);
  owner.spend.set(treasuryId, byUnit);
}

function cellsOf(owner: OwnerBucket): DashboardSpendingCell[] {
  const cells: DashboardSpendingCell[] = [];
  for (const [treasuryId, byUnit] of owner.spend) {
    for (const [unit, amount] of byUnit) {
      if (amount !== 0n) cells.push({ treasuryId, unit, amount: amount.toString() });
    }
  }
  return cells.sort((a, b) => a.treasuryId.localeCompare(b.treasuryId) || a.unit.localeCompare(b.unit));
}

function unionInto(target: Counts, source: Counts): void {
  for (const wallet of source.contributors) target.contributors.add(wallet);
  for (const task of source.tasks) target.tasks.add(task);
}

/**
 * Bucket payouts by their `spendingMonth` and refunds by the month they were
 * matched (by quarter in a long `allTimeWindow`). Contributors and tasks are counted once per bucket
 * whatever the number of payouts, which is why quarters are bucketed here and
 * not summed from months, and the period
 * counts are distinct across the selected months as well. Manual payments
 * (no task) add to spending only.
 */
export function aggregateDashboardSeries(
  payouts: readonly SeriesPayout[],
  refunds: readonly SeriesRefund[],
  window: DashboardWindow,
): Omit<DashboardSeries, "treasuries"> {
  const buckets = new Map<string, MonthBucket>(window.months.map((month) =>
    [month, { contributors: new Set(), tasks: new Set(), byOwner: new Map() }]));

  for (const payout of payouts) {
    const bucket = buckets.get(monthBucket(payout.month, window.bucket));
    if (!bucket) continue;
    const owner = ownerIn(bucket, payout.ownerType, payout.ownerId);
    if (payout.taskId !== null) {
      bucket.contributors.add(payout.contributorWallet);
      bucket.tasks.add(payout.taskId);
      owner.contributors.add(payout.contributorWallet);
      owner.tasks.add(payout.taskId);
    }
    addSpend(owner, payout.treasuryId, payout.unit, BigInt(payout.amount));
  }
  for (const refund of refunds) {
    const bucket = buckets.get(bucketKey(refund.createdAt, window.bucket));
    if (!bucket) continue;
    addSpend(ownerIn(bucket, "workgroup", refund.ownerId), refund.treasuryId, refund.unit, -BigInt(refund.amount));
  }

  const months: DashboardMonth[] = window.months.map((month) => {
    const bucket = buckets.get(month)!;
    return {
      month,
      contributors: bucket.contributors.size,
      tasks: bucket.tasks.size,
      byOwner: [...bucket.byOwner]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([ownerId, owner]) => ({
          ownerType: owner.ownerType,
          ownerId,
          contributors: owner.contributors.size,
          tasks: owner.tasks.size,
          spending: cellsOf(owner),
        })),
    };
  });

  const period: Counts = { contributors: new Set(), tasks: new Set() };
  const periodByOwner = new Map<string, Counts & { ownerType: BudgetOwnerType }>();
  for (const month of window.selected) {
    const bucket = buckets.get(month);
    if (!bucket) continue;
    unionInto(period, bucket);
    for (const [ownerId, owner] of bucket.byOwner) {
      const counts = periodByOwner.get(ownerId) ?? { ownerType: owner.ownerType, contributors: new Set(), tasks: new Set() };
      unionInto(counts, owner);
      periodByOwner.set(ownerId, counts);
    }
  }
  const stats: DashboardPeriodStats = {
    contributors: period.contributors.size,
    tasks: period.tasks.size,
    byOwner: [...periodByOwner]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ownerId, counts]) => ({
        ownerType: counts.ownerType, ownerId, contributors: counts.contributors.size, tasks: counts.tasks.size,
      })),
  };

  return { months, period: stats, bucket: window.bucket };
}

// --- Client-side selectors ------------------------------------------------------

export interface MonthPoint {
  month: string;
  contributors: number;
  tasks: number;
  spending: DashboardSpendingCell[];
}

const CELL_KEY_SEPARATOR = "|";

function mergeCells(cells: readonly DashboardSpendingCell[]): DashboardSpendingCell[] {
  const totals = new Map<string, bigint>();
  for (const cell of cells) {
    const key = `${cell.treasuryId}${CELL_KEY_SEPARATOR}${cell.unit}`;
    addQuantity(totals, key, BigInt(cell.amount));
  }
  return [...totals]
    .map(([key, amount]) => {
      const [treasuryId, unit] = key.split(CELL_KEY_SEPARATOR) as [string, string];
      return { treasuryId, unit, amount: amount.toString() };
    })
    .filter((cell) => cell.amount !== "0");
}

/** The window narrowed to one budget owner (workgroup or treasury), or every owner merged. */
export function monthsForOwner(series: DashboardSeries, ownerId: string): MonthPoint[] {
  return series.months.map((month) => {
    if (ownerId === ALL_WORKGROUPS) {
      return {
        month: month.month,
        contributors: month.contributors,
        tasks: month.tasks,
        spending: mergeCells(month.byOwner.flatMap((owner) => owner.spending)),
      };
    }
    const owner = month.byOwner.find((item) => item.ownerId === ownerId);
    return {
      month: month.month,
      contributors: owner?.contributors ?? 0,
      tasks: owner?.tasks ?? 0,
      spending: owner?.spending ?? [],
    };
  });
}

/** Distinct contributors and tasks of the selected period for the filter. */
export function periodForOwner(
  series: DashboardSeries,
  ownerId: string,
): { contributors: number; tasks: number } {
  if (ownerId === ALL_WORKGROUPS) {
    return { contributors: series.period.contributors, tasks: series.period.tasks };
  }
  const owner = series.period.byOwner.find((item) => item.ownerId === ownerId);
  return { contributors: owner?.contributors ?? 0, tasks: owner?.tasks ?? 0 };
}

/** One bar group: floats for geometry, exact strings for labels and tooltips. */
export interface ChartRow {
  key: string;
  label: string;
  selected: boolean;
  values: Record<string, number>;
  labels: Record<string, string>;
}

export interface ChartSeries {
  key: string;
  name: string;
}

export interface UnitInfo {
  ticker: string;
  decimals: number;
}

export function contributorsTasksRows(
  months: readonly MonthPoint[],
  selected: readonly string[],
  bucket: DashboardBucket = "month",
): ChartRow[] {
  return months.map((month) => ({
    key: month.month,
    label: bucketLabel(month.month, bucket),
    selected: selected.includes(month.month),
    values: { contributors: month.contributors, tasks: month.tasks },
    labels: { contributors: String(month.contributors), tasks: String(month.tasks) },
  }));
}

/**
 * Monthly spending of one token stacked by treasury. Treasuries without any
 * spending in the window are left out; past `MAX_TREASURY_SERIES` the rest
 * fold into "Other treasuries". `values.total`/`labels.total` carry the sum.
 */
export function treasurySpendingRows(
  months: readonly MonthPoint[],
  unit: string,
  info: UnitInfo,
  treasuries: readonly { id: string; name: string }[],
  selected: readonly string[],
  bucket: DashboardBucket = "month",
): { rows: ChartRow[]; series: ChartSeries[] } {
  const totals = new Map<string, bigint>();
  for (const month of months) {
    for (const cell of month.spending) {
      if (cell.unit !== unit) continue;
      addQuantity(totals, cell.treasuryId, BigInt(cell.amount));
    }
  }
  const active = treasuries.filter((treasury) => (totals.get(treasury.id) ?? 0n) !== 0n);
  for (const [treasuryId, total] of totals) {
    if (total !== 0n && !treasuries.some((treasury) => treasury.id === treasuryId)) {
      active.push({ id: treasuryId, name: "Treasury" });
    }
  }
  const shown = active.length > MAX_TREASURY_SERIES ? active.slice(0, MAX_TREASURY_SERIES - 1) : active;
  const folded = new Set(active.slice(shown.length).map((treasury) => treasury.id));
  const series: ChartSeries[] = shown.map((treasury) => ({ key: treasury.id, name: treasury.name }));
  if (folded.size > 0) series.push({ key: OTHER_TREASURIES, name: "Other treasuries" });

  const rows = months.map((month) => {
    const byKey = new Map<string, bigint>();
    let total = 0n;
    for (const cell of month.spending) {
      if (cell.unit !== unit) continue;
      const key = folded.has(cell.treasuryId) ? OTHER_TREASURIES : cell.treasuryId;
      const amount = BigInt(cell.amount);
      addQuantity(byKey, key, amount);
      total += amount;
    }
    const values: Record<string, number> = { total: chartNumber(total, info.decimals) };
    const labels: Record<string, string> = { total: formatUnits(total, info.decimals, info.ticker) };
    for (const item of series) {
      const amount = byKey.get(item.key) ?? 0n;
      values[item.key] = chartNumber(amount, info.decimals);
      labels[item.key] = formatUnits(amount, info.decimals, info.ticker);
    }
    return {
      key: month.month,
      label: bucketLabel(month.month, bucket),
      selected: selected.includes(month.month),
      values,
      labels,
    };
  });
  return { rows, series };
}

// --- Budget table ---------------------------------------------------------------

export interface BudgetTableRow {
  key: string;
  ownerType: BudgetOwnerType;
  ownerId: string;
  ownerName: string;
  unit: string;
  /** Null when the workgroup spent without a budget for this token. */
  amount: string | null;
  spent: string;
  balance: string | null;
  /** The budget's own period when it is not the view's (a quarterly project seen by month). */
  periodLabel: string | null;
}

/** Comparator: the community's main token first, then ADA, then the rest by `tickerOf`. */
export function tokenOrder(
  mainUnit: string,
  tickerOf: (unit: string) => string = (unit) => unit,
): (a: string, b: string) => number {
  return (a, b) => {
    if (a === b) return 0;
    if (a === mainUnit) return -1;
    if (b === mainUnit) return 1;
    if (a === LOVELACE) return -1;
    if (b === LOVELACE) return 1;
    return tickerOf(a).localeCompare(tickerOf(b)) || a.localeCompare(b);
  };
}

/**
 * The tokens the spending charts draw, one chart each: every token budgeted
 * in view, main token first, then ADA, then the rest by label; the main
 * token alone when nothing is budgeted. A single token chosen in the filter
 * narrows the set to itself.
 */
export function chartUnits(
  budgets: readonly Pick<BudgetSummary, "unit" | "assetLabel">[],
  mainUnit: string,
  filter: string = BUDGETED_TOKENS,
): string[] {
  if (filter !== BUDGETED_TOKENS) return [filter];
  const labels = new Map<string, string>();
  for (const budget of budgets) {
    if (!labels.has(budget.unit)) labels.set(budget.unit, budget.assetLabel);
  }
  if (labels.size === 0) return [mainUnit];
  return [...labels.keys()].sort(tokenOrder(mainUnit, (unit) => labels.get(unit) ?? unit));
}

/**
 * One row per budget owner (workgroup or treasury) and token for the view: a
 * monthly project's months are summed into its quarter row, a quarterly
 * project keeps its quarter and names it when seen by month. Owners that
 * spent without a budget get a row too, netting refunds in the view period,
 * so spending is never hidden. Tokens within an owner list the main token
 * first (ADA by default). With no `period` (all time) a row's budget is the
 * sum of the owner's periods and its spending is everything the owner spent,
 * in a budgeted period or not.
 */
export function budgetTableRows(input: {
  budgets: readonly BudgetSummary[];
  spending: readonly BudgetSpendingItem[];
  refunds: readonly BudgetRefundItem[];
  /** Null for all time. */
  period: BudgetPeriod | null;
  view: DashboardView;
  /** Owner id → display name, overriding what the rows carry. */
  names: ReadonlyMap<string, string>;
  mainUnit?: string;
}): BudgetTableRow[] {
  const byToken = tokenOrder(input.mainUnit ?? LOVELACE);
  const period = input.period;
  const inPeriod = (timestamp: string) => period === null || inBudgetPeriod(timestamp, period.start, period.end);
  interface Draft {
    ownerType: BudgetOwnerType; ownerId: string; ownerName: string; unit: string;
    amount: bigint; spent: bigint; labels: Set<string>; quarterly: boolean;
  }
  const drafts = new Map<string, Draft>();
  for (const budget of input.budgets) {
    const key = `${budget.ownerId}:${budget.unit}`;
    const draft = drafts.get(key) ?? {
      ownerType: budget.ownerType, ownerId: budget.ownerId,
      ownerName: input.names.get(budget.ownerId) ?? budget.ownerName,
      unit: budget.unit, amount: 0n, spent: 0n, labels: new Set<string>(), quarterly: false,
    };
    draft.amount += BigInt(budget.amount);
    // All time counts the items below instead: spend outside any budgeted period stays in.
    if (period !== null) draft.spent += BigInt(budget.spent);
    draft.labels.add(budget.periodLabel);
    if (budget.cadence === "quarterly") draft.quarterly = true;
    drafts.set(key, draft);
  }

  const extras = new Map<string, { ownerType: BudgetOwnerType; ownerId: string; ownerName: string; unit: string; spent: bigint }>();
  for (const item of input.spending) {
    const key = `${item.ownerId}:${item.unit}`;
    if (!inPeriod(item.createdAt)) continue;
    const draft = drafts.get(key);
    if (draft) {
      if (period === null) draft.spent += BigInt(item.amount);
      continue;
    }
    const extra = extras.get(key) ?? {
      ownerType: item.ownerType, ownerId: item.ownerId,
      ownerName: input.names.get(item.ownerId) ?? item.ownerName,
      unit: item.unit, spent: 0n,
    };
    extra.spent += BigInt(item.amount);
    extras.set(key, extra);
  }
  for (const refund of input.refunds) {
    if (!inPeriod(refund.createdAt)) continue;
    const key = `${refund.ownerId}:${refund.unit}`;
    const target = (period === null ? drafts.get(key) : undefined) ?? extras.get(key);
    if (target) target.spent -= BigInt(refund.amount);
  }
  if (period === null) {
    for (const draft of drafts.values()) if (draft.spent < 0n) draft.spent = 0n;
  }

  const rows: BudgetTableRow[] = [];
  for (const [key, draft] of drafts) {
    const [label] = draft.labels;
    rows.push({
      key,
      ownerType: draft.ownerType,
      ownerId: draft.ownerId,
      ownerName: draft.ownerName,
      unit: draft.unit,
      amount: draft.amount.toString(),
      spent: draft.spent.toString(),
      balance: (draft.amount - draft.spent).toString(),
      periodLabel: draft.quarterly && input.view === "month" ? label! : null,
    });
  }
  for (const [key, extra] of extras) {
    if (extra.spent <= 0n) continue;
    rows.push({
      key,
      ownerType: extra.ownerType,
      ownerId: extra.ownerId,
      ownerName: extra.ownerName,
      unit: extra.unit,
      amount: null,
      spent: extra.spent.toString(),
      balance: null,
      periodLabel: null,
    });
  }
  return rows.sort((a, b) =>
    a.ownerName.localeCompare(b.ownerName) || byToken(a.unit, b.unit));
}

export interface BudgetTableTotal {
  unit: string;
  /** Null when no row of this token has a budget. */
  amount: string | null;
  spent: string;
  balance: string | null;
}

/** Per-token footer totals, main token first (ADA by default). */
export function budgetTableTotals(rows: readonly BudgetTableRow[], mainUnit: string = LOVELACE): BudgetTableTotal[] {
  const totals = new Map<string, { amount: bigint | null; spent: bigint }>();
  for (const row of rows) {
    const total = totals.get(row.unit) ?? { amount: null, spent: 0n };
    if (row.amount !== null) total.amount = (total.amount ?? 0n) + BigInt(row.amount);
    total.spent += BigInt(row.spent);
    totals.set(row.unit, total);
  }
  const byToken = tokenOrder(mainUnit);
  return [...totals]
    .sort(([a], [b]) => byToken(a, b))
    .map(([unit, total]) => ({
      unit,
      amount: total.amount?.toString() ?? null,
      spent: total.spent.toString(),
      balance: total.amount === null ? null : (total.amount - total.spent).toString(),
    }));
}

/** Spending per budget owner for one token, most first; budgeted rows stay even at zero. */
export function workgroupSpendingRows(rows: readonly BudgetTableRow[], unit: string, info: UnitInfo): ChartRow[] {
  return rows
    .filter((row) => row.unit === unit && (row.amount !== null || BigInt(row.spent) > 0n))
    .sort((a, b) => {
      const difference = BigInt(b.spent) - BigInt(a.spent);
      return difference === 0n ? a.ownerName.localeCompare(b.ownerName) : difference > 0n ? 1 : -1;
    })
    .map((row) => ({
      key: row.ownerId,
      label: row.ownerName,
      selected: false,
      values: { spent: chartNumber(row.spent, info.decimals) },
      labels: {
        spent: formatUnits(row.spent, info.decimals, info.ticker),
        budget: row.amount === null ? "No budget" : formatUnits(row.amount, info.decimals, info.ticker),
      },
    }));
}

/**
 * Every token with a budget, spending or (via `extraUnits`, the funding
 * flows) an inflow in view: the main token, then ADA, then the rest.
 */
export function tokenOptions(
  budgets: readonly BudgetSummary[],
  spending: readonly BudgetSpendingItem[],
  series: DashboardSeries,
  mainUnit: string = LOVELACE,
  extraUnits: readonly string[] = [],
): string[] {
  const units = new Set<string>([mainUnit, LOVELACE, ...extraUnits]);
  for (const budget of budgets) units.add(budget.unit);
  for (const item of spending) units.add(item.unit);
  for (const month of series.months) {
    for (const owner of month.byOwner) {
      for (const cell of owner.spending) units.add(cell.unit);
    }
  }
  return [...units].sort(tokenOrder(mainUnit));
}
