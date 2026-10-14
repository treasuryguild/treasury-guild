// Budget-vs-spending for a community's workgroups and treasuries in the
// current period. Shared by the budgets/dashboard APIs and the Discord
// payout notification. A workgroup's budget consumes its task payouts and
// the history imported for it from a previous wallet; a treasury's budget
// consumes the manual payments made from it (transfers to a sibling treasury
// carry no budget month and never count).
import "server-only";

import {
  budgetOwnerLabel, resolveAllTimeBudgets, resolveSetupBudgets, type BudgetSetupContext, type BudgetView,
} from "@/lib/budgetSetups";
import type { BudgetRefundItem, BudgetSpendingItem, BudgetSummary, BudgetTotal } from "@/lib/api/types";
import { ADA_ASSET, addQuantity, LOVELACE, tokenFallbackLabel } from "@/lib/assets";
import { assetNameFromUnit } from "@/lib/cardano/assetInfo";
import { budgetAttributionTime, budgetPeriod, inBudgetPeriod } from "@/lib/budgets";
import { SPENT_PAYOUT_STATUSES, TxState, txStateMeta } from "@/lib/constants";
import { shortAddress, shortUnit } from "@/lib/format";
import { loadMintAssetHints } from "./assets";
import { allRows, must, relation, serviceClient } from "./client";
import { loadLegacySpend } from "./legacyHistory";

export type { BudgetView };

interface PayoutWithTask {
  id: string;
  amount: string;
  unit: string;
  status: string;
  created_at: string;
  tasks: { title: string; workgroup_id: string; budget_month: string | null };
  transactions: { submitted_at: string | null };
}

interface PaymentWithTx {
  id: string;
  amount: string;
  unit: string;
  treasury_id: string;
  recipient_wallet: string;
  label: string | null;
  budget_month: string;
  transactions: { state: number };
}

/** The status an imported history line shows: it was paid before this app. */
export const LEGACY_STATUS = "imported";

/** Lower bound of an all-time range: before any row, so the filter chain keeps one shape. */
export const EPOCH = "1970-01-01T00:00:00.000Z";

/** Manual payments count as spent from submission on, like payouts. */
const SPENT_TX_STATES: number[] = [TxState.Submitted, TxState.Confirmed];

interface RefundRow {
  amount: string;
  unit: string;
  created_at: string;
  payouts: { tasks: { workgroup_id: string } };
}

export interface BudgetDashboardData {
  budgets: BudgetSummary[];
  totals: BudgetTotal[];
  spending: BudgetSpendingItem[];
  refunds: BudgetRefundItem[];
  setups: BudgetSetupContext[];
}

/**
 * Budgets of every workgroup and treasury for `view` at `now` (see
 * `budgetPeriodsAt`: a month view includes a quarterly project's containing
 * quarter, a quarter view each month of a monthly project), with what has
 * been spent so far. Spending counts payouts and manual payments from
 * submission (not only confirmed) minus reconciled refunds. The Dashboard's
 * `all` view is every period from each owner's first setup through the one
 * containing `now` (`resolveAllTimeBudgets`), with all spending up to there.
 */
export async function loadBudgetDashboard(
  communityId: string,
  now: Date,
  view: BudgetView | "all",
): Promise<BudgetDashboardData> {
  const month = budgetPeriod("monthly", now);
  const quarter = budgetPeriod("quarterly", now);
  // Null = no lower bound (all time).
  const earliestStart = view === "all" ? null : month.start < quarter.start ? month.start : quarter.start;
  const db = serviceClient();

  const [budgetResult, payoutResult, refundResult, paymentResult, legacyResult] = await Promise.all([
    db.rpc("budget_setup_workspace", { p_community_id: communityId }),
    allRows<PayoutWithTask>((from, to) => db
      .from("payouts")
      .select(
        "id, amount, unit, status, created_at, tasks!inner(title, workgroup_id, budget_month, workgroups!inner(community_id)), transactions!inner(submitted_at)",
      )
      .eq("tasks.workgroups.community_id", communityId)
      .in("status", SPENT_PAYOUT_STATUSES)
      // Attribution follows the task's budget month; legacy payouts with no
      // month fall back to the submission time (narrowed in code below).
      .or(
        earliestStart === null
          ? `budget_month.is.null,budget_month.lt.${quarter.end.slice(0, 10)}`
          : `budget_month.is.null,and(budget_month.gte.${earliestStart.slice(0, 10)},budget_month.lt.${quarter.end.slice(0, 10)})`,
        { referencedTable: "tasks" },
      )
      .order("created_at", { ascending: false })
      .order("id")
      .range(from, to), "load budget spending"),
    allRows<RefundRow>((from, to) => db
      .from("reconciliations")
      .select(
        "amount, unit, created_at, payouts!inner(tasks!inner(workgroup_id, workgroups!inner(community_id)))",
      )
      .eq("payouts.tasks.workgroups.community_id", communityId)
      .gte("created_at", earliestStart ?? EPOCH)
      .lt("created_at", quarter.end)
      .order("id")
      .range(from, to), "load budget refunds"),
    allRows<PaymentWithTx>((from, to) => db
      .from("payments")
      .select("id, amount, unit, treasury_id, recipient_wallet, label, budget_month, transactions!inner(state)")
      .eq("community_id", communityId)
      .in("transactions.state", SPENT_TX_STATES)
      // Transfers have no budget month and are excluded by the range.
      .gte("budget_month", (earliestStart ?? EPOCH).slice(0, 10))
      .lt("budget_month", quarter.end.slice(0, 10))
      .order("budget_month", { ascending: false })
      .order("id")
      .range(from, to), "load budget payments"),
    loadLegacySpend(communityId, { from: earliestStart?.slice(0, 10) ?? null, to: quarter.end.slice(0, 10) }),
  ]);

  const setups = must<BudgetSetupContext[]>(budgetResult, "load budget setups");
  const budgetRows = view === "all"
    ? resolveAllTimeBudgets(setups, month.start.slice(0, 7))
    : resolveSetupBudgets(setups, (view === "quarter" ? quarter : month).start.slice(0, 7), view);
  const mintHints = await loadMintAssetHints(
    budgetRows.filter((budget) => budget.unit !== LOVELACE).map((budget) => budget.unit),
  );
  const payoutRows = payoutResult
    .map((p) => ({
      ...p,
      tasks: relation(p.tasks),
      transactions: relation(p.transactions),
    }))
    .map((p) => ({
      ...p,
      attributedAt: budgetAttributionTime({
        budgetMonth: p.tasks.budget_month,
        submittedAt: p.transactions.submitted_at,
        createdAt: p.created_at,
      }),
    }))
    .filter((p) => inBudgetPeriod(p.attributedAt, earliestStart ?? EPOCH, quarter.end));
  const refundRows = refundResult.map((r) => ({ ...r, payouts: relation(r.payouts) }));
  // A payment's budget month is a day-1 date: the period it counts against.
  const paymentRows = paymentResult.map((p) => ({
    ...p,
    transactions: relation(p.transactions),
    attributedAt: `${p.budget_month.slice(0, 10)}T00:00:00.000Z`,
  }));
  // Imported history counts against its workgroup's period like a payout.
  const legacyRows = legacyResult.map((row) => ({ ...row, attributedAt: `${row.budgetMonth}T00:00:00.000Z` }));

  const budgets: BudgetSummary[] = budgetRows.map((budget) => {
    const period = budgetPeriod(budget.cadence, new Date(`${budget.period_start}T00:00:00Z`));
    const mintHint = mintHints.get(budget.unit);
    let spent = 0n;
    if (budget.owner_type === "workgroup") {
      for (const payout of payoutRows) {
        if (
          payout.tasks.workgroup_id === budget.owner_id &&
          payout.unit === budget.unit &&
          inBudgetPeriod(payout.attributedAt, period.start, period.end)
        ) {
          spent += BigInt(payout.amount);
        }
      }
      for (const refund of refundRows) {
        const payout = relation(refund.payouts);
        const task = relation(payout.tasks);
        if (
          task.workgroup_id === budget.owner_id &&
          refund.unit === budget.unit &&
          inBudgetPeriod(refund.created_at, period.start, period.end)
        ) {
          spent -= BigInt(refund.amount);
        }
      }
      for (const row of legacyRows) {
        if (
          row.workgroupId === budget.owner_id &&
          row.unit === budget.unit &&
          inBudgetPeriod(row.attributedAt, period.start, period.end)
        ) {
          spent += BigInt(row.amount);
        }
      }
    } else {
      for (const payment of paymentRows) {
        if (
          payment.treasury_id === budget.owner_id &&
          payment.unit === budget.unit &&
          inBudgetPeriod(payment.attributedAt, period.start, period.end)
        ) {
          spent += BigInt(payment.amount);
        }
      }
    }
    if (spent < 0n) spent = 0n;
    const amount = BigInt(budget.amount);
    return {
      id: budget.id,
      budgetMonth: budget.budget_month?.slice(0, 7) ?? null,
      ownerType: budget.owner_type,
      ownerId: budget.owner_id,
      ownerName: budgetOwnerLabel(budget.owner_type, budget.owner_name),
      treasuryId: budget.treasury_id,
      workgroupKind: budget.workgroup_kind,
      cadence: budget.cadence,
      unit: budget.unit,
      assetLabel:
        mintHint?.ticker?.trim() ||
        (budget.asset_label === shortUnit(budget.unit, false)
          ? assetNameFromUnit(budget.unit)
          : budget.asset_label) ||
        assetNameFromUnit(budget.unit) ||
        (budget.unit === LOVELACE ? ADA_ASSET.fieldName : tokenFallbackLabel(budget.unit)),
      decimals:
        budget.unit === LOVELACE ? ADA_ASSET.decimals : (mintHint?.decimals ?? budget.decimals),
      amount: amount.toString(),
      spent: spent.toString(),
      balance: (amount - spent).toString(),
      periodStart: period.start,
      periodEnd: period.end,
      periodLabel: period.label,
    };
  });

  const totalBudget = new Map<string, bigint>();
  const totalSpent = new Map<string, bigint>();
  for (const budget of budgets) {
    addQuantity(totalBudget, budget.unit, BigInt(budget.amount));
    addQuantity(totalSpent, budget.unit, BigInt(budget.spent));
  }
  const totals: BudgetTotal[] = [...totalBudget].map(([unit, amount]) => {
    const spent = totalSpent.get(unit) ?? 0n;
    return {
      unit,
      amount: amount.toString(),
      spent: spent.toString(),
      balance: (amount - spent).toString(),
    };
  });

  // Every owner the workspace knows, budgeted in view or not, so spend
  // without a budget still names its workgroup or treasury.
  const names = new Map(setups.map((s) => [s.ownerId, budgetOwnerLabel(s.ownerType, s.ownerName)]));
  const spending: BudgetSpendingItem[] = [
    ...payoutRows.map((payout): BudgetSpendingItem => ({
      id: payout.id,
      kind: "payout",
      ownerType: "workgroup",
      ownerId: payout.tasks.workgroup_id,
      ownerName: names.get(payout.tasks.workgroup_id) ?? "Workgroup",
      title: payout.tasks.title,
      unit: payout.unit,
      amount: payout.amount,
      status: payout.status,
      createdAt: payout.attributedAt,
    })),
    ...paymentRows.map((payment): BudgetSpendingItem => ({
      id: payment.id,
      kind: "payment",
      ownerType: "treasury",
      ownerId: payment.treasury_id,
      ownerName: names.get(payment.treasury_id) ?? budgetOwnerLabel("treasury", "Treasury"),
      title: payment.label ?? shortAddress(payment.recipient_wallet),
      unit: payment.unit,
      amount: payment.amount,
      status: txStateMeta(payment.transactions.state).label.toLowerCase(),
      createdAt: payment.attributedAt,
    })),
    ...legacyRows.map((row): BudgetSpendingItem => ({
      id: row.id,
      kind: "legacy",
      ownerType: "workgroup",
      ownerId: row.workgroupId,
      ownerName: names.get(row.workgroupId) ?? row.workgroupName,
      title: row.task,
      unit: row.unit,
      amount: row.amount,
      status: LEGACY_STATUS,
      createdAt: row.attributedAt,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const refunds: BudgetRefundItem[] = refundRows.map((refund) => ({
    ownerId: relation(refund.payouts.tasks).workgroup_id,
    unit: refund.unit,
    amount: refund.amount,
    createdAt: refund.created_at,
  }));

  return { budgets, totals, spending, refunds, setups };
}

/**
 * Current-period budgets of the given workgroups whatever their cadence: the
 * month view already resolves a quarterly project to its containing quarter.
 */
export async function loadWorkgroupBudgets(
  communityId: string,
  workgroupIds: readonly string[],
  now: Date,
): Promise<BudgetSummary[]> {
  if (workgroupIds.length === 0) return [];
  const wanted = new Set(workgroupIds);
  const { budgets } = await loadBudgetDashboard(communityId, now, "month");
  return budgets.filter((b) => b.ownerType === "workgroup" && wanted.has(b.ownerId));
}
