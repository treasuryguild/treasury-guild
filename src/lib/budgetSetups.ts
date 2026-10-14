import type { BudgetCadence } from "@/lib/budgets";
import {
  BUDGET_MONTH_RE, alignBudgetMonth, budgetPeriodCode, currentBudgetMonth, nextQuarterStart, quarterMonths, shiftMonth,
} from "@/lib/budgets";
import { formatUnits } from "@/lib/format";

/** Worksheet/dashboard views: a month, a quarter grid, or recurring defaults. */
export type BudgetView = "month" | "quarter" | "recurring";
export type BudgetMode = "recurring" | "monthly" | "quarterly";
export interface BudgetAmount {
  unit: string; amount: string; asset_label: string | null; decimals: number;
}

/** "1,500 ADA" for one stored budget amount. */
export function budgetAmountLabel(a: Pick<BudgetAmount, "unit" | "amount" | "asset_label" | "decimals">): string {
  return formatUnits(a.amount, a.decimals, a.asset_label ?? a.unit);
}

/** Stored budget amounts joined for a sentence; `empty` when there are none. */
export function budgetAmountsText(amounts: readonly BudgetAmount[], empty: string): string {
  return amounts.map(budgetAmountLabel).join(", ") || empty;
}
export interface BudgetSetup {
  id: string; starts_on: string; mode: BudgetMode; cadence: BudgetCadence; amounts: BudgetAmount[];
}
/** Who a budget belongs to: a workgroup's board, or a treasury's manual payments. */
export type BudgetOwnerType = "workgroup" | "treasury";
export interface BudgetSetupContext {
  ownerType: BudgetOwnerType; ownerId: string; ownerName: string;
  /** Set for a workgroup owner. */
  workgroupId: string | null; workgroupKind: string | null;
  /** Set for a treasury owner. */
  treasuryId: string | null;
  revision: number; legacyConflict: boolean; timeline: BudgetSetup[];
  plans: { setup_id: string; starts_on: string; amounts: BudgetAmount[] }[];
  legacy: (BudgetAmount & { cadence: BudgetCadence; budget_month: string | null })[];
  history: { changed_at: string; changed_by: string; effective_on: string; reason: string | null;
    before_value: { setup: BudgetSetup | null; plans: BudgetSetupContext["plans"] };
    after_value: { mode: BudgetMode; cadence: BudgetCadence; amounts: BudgetAmount[] } }[];
}
export interface BudgetSetupDraft {
  mode: BudgetMode; cadence: BudgetCadence; startsOn: string; reason: string;
}
/** The display name of a budget owner: treasuries are prefixed so rows read apart from workgroups. */
export function budgetOwnerLabel(ownerType: BudgetOwnerType, name: string): string {
  return ownerType === "treasury" ? `Treasury: ${name}` : name;
}
export function contextForOwner(contexts: readonly BudgetSetupContext[], ownerId: string): BudgetSetupContext | undefined {
  return contexts.find((context) => context.ownerId === ownerId);
}
export function setupAt(context: BudgetSetupContext | undefined, month: string): BudgetSetup | undefined {
  return context?.timeline.filter((s) => s.starts_on <= `${month}-01`)
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0];
}
/**
 * Cadence of the setup in force for `month` ("YYYY-MM"), or null when the
 * workgroup has no setup yet. Drives the quarterly hint on the task dialog.
 */
export function cadenceAt(
  setups: readonly Pick<BudgetSetup, "starts_on" | "cadence">[],
  month: string,
): BudgetCadence | null {
  if (!BUDGET_MONTH_RE.test(month)) return null;
  const active = setups
    .filter((s) => s.starts_on <= `${month}-01`)
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0];
  return active?.cadence ?? null;
}
export interface TaskBudgetPeriod {
  /** Month the task is stored under ("YYYY-MM"), quarter-aligned when quarterly. */
  month: string;
  /** Period written on-chain: "YYYY-MM" or "YYYY-Qn". */
  code: string;
}
/**
 * The budget period a task counts against: its own budget month, or
 * `defaultMonth` when it has none, read through the workgroup's setup in
 * force for that month. The one home for "which period is this task in" at
 * payout time — a mid-quarter date in a quarterly workgroup still resolves
 * to the quarter.
 */
export function taskBudgetPeriod(
  budgetMonth: string | null,
  setups: readonly Pick<BudgetSetup, "starts_on" | "cadence">[],
  defaultMonth: string,
): TaskBudgetPeriod {
  const raw = budgetMonth?.slice(0, 7) ?? defaultMonth;
  const cadence = cadenceAt(setups, raw);
  return { month: alignBudgetMonth(raw, cadence), code: budgetPeriodCode(raw, cadence) };
}
/** A setup or plan row as the build routes read it: with the proposal that set it (0059), when one did. */
export interface BudgetSetupSource extends BudgetSetup {
  owner_key: string;
  proposal_id: string | null;
}
export interface BudgetPlanSource {
  setup_id: string; starts_on: string; amounts: BudgetAmount[]; proposal_id: string | null;
}
/** The budget an owner has for one period: its amounts and the proposal that set them. */
export interface BudgetInForce {
  setupId: string;
  /** First month of the period ("YYYY-MM"), aligned to the setup's cadence. */
  periodMonth: string;
  cadence: BudgetCadence;
  amounts: BudgetAmount[];
  /** The proposal whose apply wrote the plan row (else the setup row); null when saved directly. */
  proposalId: string | null;
}
/**
 * The budget in force for one owner at `month` ("YYYY-MM"): the latest setup
 * started by then, with a recurring setup's own amounts or the plan row of
 * the period. Null when the owner has no setup by then, or a planned setup
 * has no plan for that period: nothing was budgeted. The one home for "which
 * budget (and which decision) does this spend count against".
 */
export function budgetInForce(
  setups: readonly BudgetSetupSource[],
  plans: readonly BudgetPlanSource[],
  month: string,
): BudgetInForce | null {
  const setup = setups.filter((s) => s.starts_on <= `${month}-01`)
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0];
  if (!setup) return null;
  const periodMonth = alignBudgetMonth(month, setup.cadence);
  if (setup.mode === "recurring") {
    if (setup.amounts.length === 0) return null;
    return { setupId: setup.id, periodMonth, cadence: setup.cadence, amounts: setup.amounts, proposalId: setup.proposal_id };
  }
  const plan = plans.find((p) => p.setup_id === setup.id && p.starts_on === `${periodMonth}-01`);
  if (!plan || plan.amounts.length === 0) return null;
  return {
    setupId: setup.id, periodMonth, cadence: setup.cadence, amounts: plan.amounts,
    proposalId: plan.proposal_id ?? setup.proposal_id,
  };
}
export function setupLabel(setup: Pick<BudgetSetup, "mode" | "cadence">): string {
  return setup.mode === "recurring" ? `Recurring ${setup.cadence}` : setup.mode === "monthly" ? "Monthly plan" : "Quarterly plan";
}
export interface BudgetPeriodCell {
  /** First month of the period, "YYYY-MM". */
  start: string;
  cadence: BudgetCadence;
  setup: BudgetSetup;
}
/**
 * The budget periods a workgroup is planned in for `view` at `month`: the
 * one home for "which cells does this project show". A month view shows a
 * monthly project's month or a quarterly project's containing quarter; a
 * quarter view shows each month of the quarter for a monthly project and the
 * quarter once for a quarterly one (a mid-quarter cadence switch yields
 * both); the recurring view only lists recurring setups.
 */
export function budgetPeriodsAt(context: BudgetSetupContext | undefined, month: string, view: BudgetView): BudgetPeriodCell[] {
  if (view === "recurring") {
    const setup = setupAt(context, month);
    return setup?.mode === "recurring" ? [{ start: month, cadence: setup.cadence, setup }] : [];
  }
  const cells: BudgetPeriodCell[] = [];
  for (const m of view === "quarter" ? quarterMonths(month) : [month]) {
    const setup = setupAt(context, m);
    if (!setup) continue;
    const start = alignBudgetMonth(m, setup.cadence);
    if (!cells.some((cell) => cell.setup.id === setup.id && cell.start === start)) {
      cells.push({ start, cadence: setup.cadence, setup });
    }
  }
  return cells;
}

/** The amounts a setup supplies for the period starting at `start` ("YYYY-MM"). */
export function periodAmounts(context: BudgetSetupContext, cell: BudgetPeriodCell): BudgetAmount[] {
  return cell.setup.mode === "recurring" ? cell.setup.amounts
    : context.plans.find((p) => p.setup_id === cell.setup.id && p.starts_on === `${cell.start}-01`)?.amounts ?? [];
}

function cellBudgets(context: BudgetSetupContext, cell: BudgetPeriodCell) {
  const start = `${cell.start}-01`;
  return periodAmounts(context, cell).map((amount) => ({ ...amount, id: `${cell.setup.id}:${start}:${amount.unit}`,
    owner_type: context.ownerType, owner_id: context.ownerId, owner_name: context.ownerName,
    treasury_id: context.treasuryId, workgroup_kind: context.workgroupKind, cadence: cell.cadence,
    budget_month: cell.setup.mode === "recurring" ? null : start,
    period_start: start }));
}

/** Only the active setup supplies amounts. Missing explicit plans stay empty. */
export function resolveSetupBudgets(contexts: BudgetSetupContext[], month: string, view: BudgetView) {
  return contexts.flatMap((context) => budgetPeriodsAt(context, month, view).flatMap((cell) => cellBudgets(context, cell)));
}

/**
 * Every budget period of each owner from its first setup through
 * `throughMonth` ("YYYY-MM"), for the Dashboard's all-time view: a recurring
 * budget counts once per elapsed period, a quarter containing `throughMonth`
 * counts whole (as the month view shows it), later plans are left out.
 */
export function resolveAllTimeBudgets(contexts: BudgetSetupContext[], throughMonth: string) {
  return contexts.flatMap((context) => {
    const first = context.timeline.map((setup) => setup.starts_on.slice(0, 7)).sort()[0];
    if (!first) return [];
    const cells = new Map<string, BudgetPeriodCell>();
    for (let month = first; month <= throughMonth; month = shiftMonth(month, 1)) {
      for (const cell of budgetPeriodsAt(context, month, "month")) cells.set(`${cell.setup.id}:${cell.start}`, cell);
    }
    return [...cells.values()].flatMap((cell) => cellBudgets(context, cell));
  });
}
/**
 * No setup in force at `month` and nothing to review: a setup saved there is a
 * backfill before the owner's first setup (or its very first one). It may
 * start in the past and runs until that first setup (`save_budget_setup`).
 */
export function isBackfill(context: BudgetSetupContext | undefined, month: string): boolean {
  return !context || (!context.legacyConflict && !setupAt(context, month));
}

/** The first setup starting after `month`: where a backfill from `month` ends. */
export function nextSetupAfter(context: BudgetSetupContext | undefined, month: string): BudgetSetup | undefined {
  return context?.timeline.filter((s) => s.starts_on > `${month}-01`)
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0];
}

/** A backfill involving a quarterly budget must end on a quarter month, so no quarter is cut short. */
export function backfillEndsOffQuarter(context: BudgetSetupContext | undefined, start: string, cadence: BudgetCadence): boolean {
  if (!isBackfill(context, start)) return false;
  const next = nextSetupAfter(context, start);
  return !!next && (cadence === "quarterly" || next.cadence === "quarterly") &&
    !["01", "04", "07", "10"].includes(next.starts_on.slice(5, 7));
}

/**
 * The earliest month a setup may start at when the dialog opens on
 * `requested`: that month itself for a backfill (aligned to its quarter),
 * else the current month at the soonest, as a setup change never rewrites
 * completed periods.
 */
export function earliestSetupMonth(context: BudgetSetupContext | undefined, requested: string, cadence: BudgetCadence): string {
  if (isBackfill(context, requested)) return alignBudgetMonth(requested, cadence);
  let month = requested < currentBudgetMonth() ? currentBudgetMonth() : requested;
  const old = setupAt(context, month);
  if (cadence === "quarterly" || old?.cadence === "quarterly" || !old && context?.legacy.some((b) => b.cadence === "quarterly")) {
    month = nextQuarterStart(month);
  }
  return month;
}
