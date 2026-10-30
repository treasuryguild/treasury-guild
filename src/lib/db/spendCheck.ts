// What is already spent against the budget periods a build touches, for the
// spending check (src/lib/governance/spendCheck.ts). The same rows the
// Dashboard counts (budgetDashboard.ts: payouts from submission on minus
// reconciled refunds plus imported history for a workgroup; submitted
// manual payments for a treasury), plus the rows of pending transactions,
// which the Dashboard leaves out but a second build must not overlook.
import "server-only";

import { budgetAttributionTime, budgetPeriod, inBudgetPeriod, type BudgetCadence } from "@/lib/budgets";
import { PayoutStatus, SPENT_PAYOUT_STATUSES, TxState } from "@/lib/constants";
import type { SpentAmount } from "@/lib/governance/spendCheck";
import { allRows, relation, serviceClient } from "./client";
import { loadLegacySpend } from "./legacyHistory";

/** One owner's period the check needs the spending of. */
export interface SpentTarget {
  ownerKey: string;
  ownerType: "workgroup" | "treasury";
  ownerId: string;
  /** The period's first month ("YYYY-MM"). */
  periodMonth: string;
  cadence: BudgetCadence;
}

interface PayoutRow {
  transaction_id: string;
  amount: string;
  unit: string;
  status: string;
  created_at: string;
  tasks: { workgroup_id: string; budget_month: string | null };
  transactions: { state: number; submitted_at: string | null };
}

interface RefundRow {
  amount: string;
  unit: string;
  created_at: string;
  payouts: { tasks: { workgroup_id: string } };
}

interface PaymentRow {
  transaction_id: string;
  amount: string;
  unit: string;
  treasury_id: string;
  budget_month: string | null;
  transactions: { state: number };
}

const COUNTED_TX_STATES: number[] = [
  TxState.Pending, TxState.Submitted, TxState.Confirmed, TxState.Canceled,
];

/**
 * Spent per (owner, period, unit) for these targets; refunds may leave a
 * negative total, as the Dashboard clamps. `excludeTransactionId` leaves one
 * transaction's own rows out: the co-signer check runs on a pending
 * transaction whose rows would otherwise count against itself.
 */
export async function loadSpentForTargets(
  communityId: string,
  targets: readonly SpentTarget[],
  options: { excludeTransactionId?: string } = {},
): Promise<SpentAmount[]> {
  if (targets.length === 0) return [];
  const excluded = options.excludeTransactionId ?? null;
  const windows = targets.map((t) => ({ ...t, ...budgetPeriod(t.cadence, new Date(`${t.periodMonth}-01T00:00:00Z`)) }));
  const from = windows.map((w) => w.start).sort()[0]!;
  const to = windows.map((w) => w.end).sort().at(-1)!;
  const workgroupIds = [...new Set(windows.filter((w) => w.ownerType === "workgroup").map((w) => w.ownerId))];
  const treasuryIds = [...new Set(windows.filter((w) => w.ownerType === "treasury").map((w) => w.ownerId))];
  const db = serviceClient();

  const [payouts, refunds, legacy, payments] = await Promise.all([
    workgroupIds.length === 0 ? [] : allRows<PayoutRow>((a, b) => db
      .from("payouts")
      .select("transaction_id, amount, unit, status, created_at, tasks!inner(workgroup_id, budget_month), transactions!inner(state, submitted_at)")
      .in("tasks.workgroup_id", workgroupIds)
      .in("transactions.state", COUNTED_TX_STATES)
      .or(`budget_month.is.null,and(budget_month.gte.${from.slice(0, 10)},budget_month.lt.${to.slice(0, 10)})`, { referencedTable: "tasks" })
      .order("id")
      .range(a, b), "load spent payouts"),
    workgroupIds.length === 0 ? [] : allRows<RefundRow>((a, b) => db
      .from("reconciliations")
      .select("amount, unit, created_at, payouts!inner(tasks!inner(workgroup_id))")
      .in("payouts.tasks.workgroup_id", workgroupIds)
      .gte("created_at", from)
      .lt("created_at", to)
      .order("id")
      .range(a, b), "load spent refunds"),
    workgroupIds.length === 0 ? [] : loadLegacySpend(communityId, { from: from.slice(0, 10), to: to.slice(0, 10) }),
    treasuryIds.length === 0 ? [] : allRows<PaymentRow>((a, b) => db
      .from("payments")
      .select("transaction_id, amount, unit, treasury_id, budget_month, transactions!inner(state)")
      .in("treasury_id", treasuryIds)
      .in("transactions.state", COUNTED_TX_STATES)
      .gte("budget_month", from.slice(0, 10))
      .lt("budget_month", to.slice(0, 10))
      .order("id")
      .range(a, b), "load spent payments"),
  ]);

  const totals = new Map<string, SpentAmount>();
  const add = (ownerKey: string, periodMonth: string, unit: string, amount: bigint) => {
    const key = `${ownerKey}|${periodMonth}|${unit}`;
    const entry = totals.get(key);
    if (entry) entry.amount += amount;
    else totals.set(key, { ownerKey, periodMonth, unit, amount });
  };

  for (const w of windows) {
    if (w.ownerType === "workgroup") {
      for (const p of payouts) {
        const task = relation(p.tasks);
        const tx = relation(p.transactions);
        if (task.workgroup_id !== w.ownerId || p.transaction_id === excluded) continue;
        // Submitted rows count whatever came after; a pending row counts only while its transaction is.
        const counted = (SPENT_PAYOUT_STATUSES as readonly string[]).includes(p.status) ||
          (p.status === PayoutStatus.Pending && tx.state === TxState.Pending);
        if (!counted) continue;
        const at = budgetAttributionTime({ budgetMonth: task.budget_month, submittedAt: tx.submitted_at, createdAt: p.created_at });
        if (inBudgetPeriod(at, w.start, w.end)) add(w.ownerKey, w.periodMonth, p.unit, BigInt(p.amount));
      }
      for (const r of refunds) {
        if (relation(relation(r.payouts).tasks).workgroup_id !== w.ownerId) continue;
        if (inBudgetPeriod(r.created_at, w.start, w.end)) add(w.ownerKey, w.periodMonth, r.unit, -BigInt(r.amount));
      }
      for (const row of legacy) {
        if (row.workgroupId !== w.ownerId) continue;
        if (inBudgetPeriod(`${row.budgetMonth}T00:00:00.000Z`, w.start, w.end)) add(w.ownerKey, w.periodMonth, row.unit, BigInt(row.amount));
      }
    } else {
      for (const p of payments) {
        if (p.treasury_id !== w.ownerId || p.transaction_id === excluded) continue;
        // A transfer carries no period and is never spend.
        if (p.budget_month === null) continue;
        if (inBudgetPeriod(`${p.budget_month.slice(0, 10)}T00:00:00.000Z`, w.start, w.end)) {
          add(w.ownerKey, w.periodMonth, p.unit, BigInt(p.amount));
        }
      }
    }
  }
  return [...totals.values()];
}
