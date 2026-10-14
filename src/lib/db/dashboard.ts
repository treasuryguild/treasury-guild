// Dashboard-only reads: the budget-period series behind the charts and the
// recent treasury inflows. Budget-vs-spending stays in budgetDashboard.ts.
import "server-only";

import type { BudgetIncomingItem, DashboardFlows, DashboardLegacy, DashboardSeries } from "@/lib/api/types";
import { monthOf, quarterStartMonth } from "@/lib/budgets";
import { cadenceAt } from "@/lib/budgetSetups";
import { SPENT_PAYOUT_STATUSES, TxState } from "@/lib/constants";
import {
  aggregateDashboardSeries,
  allTimeWindow,
  dashboardWindow,
  spendingMonth,
  type DashboardView,
  type DashboardWindow,
  type SeriesPayout,
  type SeriesRefund,
} from "@/lib/dashboardSeries";
import { aggregateFlows, type FlowIncomingRow } from "@/lib/fundingFlow";
import { EPOCH } from "./budgetDashboard";
import { loadBudgetSetupsForTreasuries, loadBudgetSetupsForWorkgroups, type BudgetSetupCadenceRow } from "./budgetSetups";
import { allRows, relation, rows, serviceClient } from "./client";
import { legacyContributorKey, legacyTaskKey } from "@/lib/legacyHistory/display";
import { loadKnownWallets, loadLegacySpend, loadLegacyWallets } from "./legacyHistory";

interface PayoutSeriesRow {
  id: string;
  task_id: string;
  contributor_wallet: string;
  unit: string;
  amount: string;
  created_at: string;
  tasks: { workgroup_id: string; budget_month: string | null };
  transactions: { submitted_at: string | null; treasury_id: string };
}

interface RefundSeriesRow {
  amount: string;
  unit: string;
  created_at: string;
  payouts: { tasks: { workgroup_id: string }; transactions: { treasury_id: string } };
}

interface PaymentSeriesRow {
  id: string;
  recipient_wallet: string;
  treasury_id: string;
  unit: string;
  amount: string;
  budget_month: string | null;
  created_at: string;
  transactions: { submitted_at: string | null };
}

interface IncomingWithTreasury {
  tx_hash: string;
  amount_lovelace: string;
  assets: Record<string, string> | null;
  block_time: string | null;
  incoming_type: string;
  requires_reconciliation: boolean;
  matched: boolean;
  treasuries: { name: string; community_id: string };
  from_treasury: { name: string } | null;
}

interface IncomingFlowRow {
  treasury_id: string;
  from_treasury_id: string | null;
  funding_source_id: string | null;
  incoming_type: string;
  amount_lovelace: string;
  assets: Record<string, string> | null;
  block_time: string | null;
}

/**
 * The chart series and the funding flows over one shared window: the trailing
 * window ending at `month` (or at the quarter containing it), or for `all`
 * the whole history through `month`, which is only known once the rows are
 * read (`allTimeWindow` starts at the first activity).
 *
 * Series: payouts and manual payments bucketed by budget period, the month
 * they were paid clamped into their task's (or payment's) period read through
 * the owner's setup timeline (`spendingMonth`), the payment month when no
 * period is set; refunds by the month they were matched. Transfers to a
 * sibling treasury are left out: the receiver's tagged inflow already carries
 * them into the funding flow. History imported from a previous wallet is
 * workgroup spend paid from that wallet (its id in the treasury slot); its
 * lines count as tasks (one per workgroup, date and task text) and its
 * recipients as contributors, merged with a member whose wallet is the only
 * one ending with the recipient's address end.
 * Flows: inflows bucketed by block-time month, outside income by kind (or by
 * the funding source an admin tied it to) per treasury, and transfers between
 * the community's own treasuries (rows tagged by tag_internal_transfers).
 */
export async function loadDashboardActivity(
  communityId: string,
  month: string,
  view: DashboardView,
): Promise<{ series: DashboardSeries; flows: DashboardFlows; legacy: DashboardLegacy; fundingSources: { id: string; name: string }[] }> {
  const range = view === "all"
    ? { start: EPOCH, end: allTimeWindow(null, month).end }
    : dashboardWindow(month, view);
  // Budget months that can draw inside the window: a quarter's first month up
  // to two months before it still places spending in its later months. Rows
  // with no budget month (legacy) fall back to the payment month and are all
  // read; buckets outside the window are dropped by the aggregation.
  const budgetMonthRange =
    `budget_month.is.null,and(budget_month.gte.${quarterStartMonth(monthOf(range.start))}-01,budget_month.lt.${range.end.slice(0, 10)})`;
  const db = serviceClient();

  const [flowRows, payoutRows, refundRows, paymentRows, treasuryRows, legacyRows, legacyWallets, fundingRows] = await Promise.all([
    allRows<IncomingFlowRow>((from, to) => db
      .from("incoming_txs")
      .select("treasury_id, from_treasury_id, funding_source_id, incoming_type, amount_lovelace, assets, block_time, treasuries!incoming_txs_treasury_id_fkey!inner(community_id)")
      .eq("treasuries.community_id", communityId)
      .gte("block_time", range.start)
      .lt("block_time", range.end)
      .order("tx_hash")
      .range(from, to), "load dashboard flows"),
    allRows<PayoutSeriesRow>((from, to) => db
      .from("payouts")
      .select(
        "id, task_id, contributor_wallet, unit, amount, created_at, tasks!inner(workgroup_id, budget_month, workgroups!inner(community_id)), transactions!inner(submitted_at, treasury_id)",
      )
      .eq("tasks.workgroups.community_id", communityId)
      .in("status", SPENT_PAYOUT_STATUSES)
      .or(budgetMonthRange, { referencedTable: "tasks" })
      .order("id")
      .range(from, to), "load dashboard payouts"),
    allRows<RefundSeriesRow>((from, to) => db
      .from("reconciliations")
      .select(
        "amount, unit, created_at, payouts!inner(tasks!inner(workgroup_id, workgroups!inner(community_id)), transactions!inner(treasury_id))",
      )
      .eq("payouts.tasks.workgroups.community_id", communityId)
      .gte("created_at", range.start)
      .lt("created_at", range.end)
      .order("id")
      .range(from, to), "load dashboard refunds"),
    allRows<PaymentSeriesRow>((from, to) => db
      .from("payments")
      .select("id, recipient_wallet, treasury_id, unit, amount, budget_month, created_at, transactions!inner(submitted_at)")
      .eq("community_id", communityId)
      .is("recipient_treasury_id", null)
      .in("transactions.state", [TxState.Submitted, TxState.Confirmed])
      .or(budgetMonthRange)
      .order("id")
      .range(from, to), "load dashboard payments"),
    db
      .from("treasuries")
      .select("id, name")
      .eq("community_id", communityId)
      .order("created_at"),
    loadLegacySpend(communityId, {
      from: `${quarterStartMonth(monthOf(range.start))}-01`,
      to: range.end.slice(0, 10),
    }),
    loadLegacyWallets(communityId),
    db.from("funding_sources").select("id, name").eq("community_id", communityId).order("name"),
  ]);

  const [workgroupSetups, treasurySetups, knownWallets] = await Promise.all([
    loadBudgetSetupsForWorkgroups([...new Set([
      ...payoutRows.map((row) => relation(row.tasks).workgroup_id),
      ...legacyRows.map((row) => row.workgroupId),
    ])]),
    loadBudgetSetupsForTreasuries([...new Set(paymentRows.map((row) => row.treasury_id))]),
    legacyRows.length > 0 ? loadKnownWallets(communityId) : Promise.resolve([]),
  ]);
  const monthIn = (setups: BudgetSetupCadenceRow[] | undefined, budgetMonth: string | null, paidAt: string) =>
    spendingMonth({
      budgetMonth,
      paidAt,
      cadence: budgetMonth === null ? null : cadenceAt(setups ?? [], budgetMonth.slice(0, 7)),
    });

  const payouts: SeriesPayout[] = [
    ...payoutRows.map((row): SeriesPayout => {
      const tx = relation(row.transactions);
      const task = relation(row.tasks);
      return {
        taskId: row.task_id,
        contributorWallet: row.contributor_wallet,
        ownerType: "workgroup",
        ownerId: task.workgroup_id,
        treasuryId: tx.treasury_id,
        unit: row.unit,
        amount: row.amount,
        month: monthIn(workgroupSetups.get(task.workgroup_id), task.budget_month, tx.submitted_at ?? row.created_at),
      };
    }),
    ...paymentRows.map((row): SeriesPayout => ({
      taskId: null,
      contributorWallet: row.recipient_wallet,
      ownerType: "treasury",
      ownerId: row.treasury_id,
      treasuryId: row.treasury_id,
      unit: row.unit,
      amount: row.amount,
      month: monthIn(
        treasurySetups.get(row.treasury_id),
        row.budget_month,
        relation(row.transactions).submitted_at ?? row.created_at,
      ),
    })),
    ...legacyRows.map((row): SeriesPayout => ({
      taskId: legacyTaskKey(row),
      contributorWallet: legacyContributorKey(row.recipientRef, knownWallets),
      ownerType: "workgroup",
      ownerId: row.workgroupId,
      treasuryId: row.legacyWalletId,
      unit: row.unit,
      amount: row.amount,
      month: monthIn(workgroupSetups.get(row.workgroupId), row.budgetMonth, `${row.paidOn}T00:00:00.000Z`),
    })),
  ];
  const refunds: SeriesRefund[] = refundRows.map((row) => {
    const payout = relation(row.payouts);
    return {
      ownerId: relation(payout.tasks).workgroup_id,
      treasuryId: relation(payout.transactions).treasury_id,
      unit: row.unit,
      amount: row.amount,
      createdAt: row.created_at,
    };
  });
  const treasuries = rows<{ id: string; name: string }>(treasuryRows, "load dashboard treasuries");
  const flows: FlowIncomingRow[] = flowRows.map((row) => ({
    treasuryId: row.treasury_id,
    fromTreasuryId: row.from_treasury_id,
    incomingType: row.incoming_type,
    amountLovelace: row.amount_lovelace,
    assets: row.assets,
    blockTime: row.block_time,
    fundingSourceId: row.funding_source_id,
  }));

  let window: DashboardWindow;
  if (view === "all") {
    const months = [
      ...payouts.map((payout) => payout.month),
      ...refunds.map((refund) => monthOf(refund.createdAt)),
      ...flows.flatMap((row) => (row.blockTime ? [monthOf(row.blockTime)] : [])),
    ];
    const first = months.reduce<string | null>((earliest, key) =>
      earliest === null || key < earliest ? key : earliest, null);
    window = allTimeWindow(first, month);
  } else {
    window = dashboardWindow(month, view);
  }

  const assets = new Map(legacyRows.map((row) => [row.unit, { unit: row.unit, ticker: row.ticker, decimals: row.decimals }]));
  return {
    series: { ...aggregateDashboardSeries(payouts, refunds, window), treasuries },
    flows: { months: aggregateFlows(flows, window) },
    legacy: {
      wallets: legacyWallets.map((wallet) => ({ id: wallet.id, name: wallet.name })),
      assets: [...assets.values()],
    },
    fundingSources: rows<{ id: string; name: string }>(fundingRows, "load funding sources"),
  };
}

/** The latest inflows across the community's treasuries, newest first. */
export async function loadRecentIncoming(
  communityId: string,
  limit = 8,
): Promise<BudgetIncomingItem[]> {
  const result = await serviceClient()
    .from("incoming_txs")
    .select(
      "tx_hash, amount_lovelace, assets, block_time, incoming_type, requires_reconciliation, matched, treasuries!incoming_txs_treasury_id_fkey!inner(name, community_id), from_treasury:treasuries!incoming_txs_from_treasury_id_fkey(name)",
    )
    .eq("treasuries.community_id", communityId)
    .order("block_time", { ascending: false })
    .limit(limit);

  return rows<IncomingWithTreasury>(result, "load recent incoming").map((item) => ({
    txHash: item.tx_hash,
    treasuryName: relation(item.treasuries).name,
    fromTreasuryName: item.from_treasury ? relation(item.from_treasury).name : null,
    amountLovelace: item.amount_lovelace,
    assets: item.assets,
    blockTime: item.block_time,
    incomingType: item.incoming_type,
    requiresReconciliation: item.requires_reconciliation,
    matched: item.matched,
  }));
}
