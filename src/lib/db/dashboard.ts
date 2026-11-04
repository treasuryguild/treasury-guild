// Dashboard-only reads: the budget-period series behind the charts and the
// recent treasury inflows. Budget-vs-spending stays in budgetDashboard.ts.
import "server-only";

import type { BudgetIncomingItem, DashboardFlows, DashboardLegacy, DashboardSeries } from "@/lib/api/types";
import { LOVELACE } from "@/lib/assets";
import { monthOf, quarterStartMonth } from "@/lib/budgets";
import { cadenceAt } from "@/lib/budgetSetups";
import { SPENT_PAYOUT_STATUSES, TxState } from "@/lib/constants";
import { sumConversionFees } from "@/lib/conversions/fees";
import {
  aggregateDashboardSeries,
  allTimeWindow,
  bucketKey,
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
import { loadCommunityConversions } from "./conversions";
import { legacyContributorKey, legacyTaskKey } from "@/lib/legacyHistory/display";
import { loadKnownWallets, loadLegacyReceipts, loadLegacySpend, loadLegacyWallets } from "./legacyHistory";
import type { DashboardConversionFee } from "@/lib/api/types";

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
  from_float_wallet_id: string | null;
  funding_source_id: string | null;
  incoming_type: string;
  amount_lovelace: string;
  assets: Record<string, string> | null;
  block_time: string | null;
}

interface FloatIncomingFlowRow {
  float_wallet_id: string;
  from_treasury_id: string | null;
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
 * the community's own treasuries and float wallets (tag_internal_transfers /
 * tag_float_transfers).
 */
export async function loadDashboardActivity(
  communityId: string,
  month: string,
  view: DashboardView,
): Promise<{
  series: DashboardSeries;
  flows: DashboardFlows;
  legacy: DashboardLegacy;
  floats: { id: string; name: string }[];
  fundingSources: { id: string; name: string }[];
  conversionFees: DashboardConversionFee[];
}> {
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

  const [flowRows, floatFlowRows, payoutRows, refundRows, paymentRows, treasuryRows, floatWalletRows, legacyRows, legacyReceiptRows, legacyWallets, fundingRows, conversions] = await Promise.all([
    allRows<IncomingFlowRow>((from, to) => db
      .from("incoming_txs")
      .select("treasury_id, from_treasury_id, from_float_wallet_id, funding_source_id, incoming_type, amount_lovelace, assets, block_time, treasuries!incoming_txs_treasury_id_fkey!inner(community_id)")
      .eq("treasuries.community_id", communityId)
      .gte("block_time", range.start)
      .lt("block_time", range.end)
      .order("tx_hash")
      .range(from, to), "load dashboard flows"),
    allRows<FloatIncomingFlowRow>((from, to) => db
      .from("float_incoming_txs")
      .select("float_wallet_id, from_treasury_id, amount_lovelace, assets, block_time, float_wallets!inner(community_id)")
      .eq("float_wallets.community_id", communityId)
      .not("from_treasury_id", "is", null)
      .gte("block_time", range.start)
      .lt("block_time", range.end)
      .order("tx_hash")
      .range(from, to), "load dashboard float flows"),
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
      .is("recipient_float_wallet_id", null)
      .in("transactions.state", [TxState.Submitted, TxState.Confirmed])
      .or(budgetMonthRange)
      .order("id")
      .range(from, to), "load dashboard payments"),
    db
      .from("treasuries")
      .select("id, name")
      .eq("community_id", communityId)
      .order("created_at"),
    db
      .from("float_wallets")
      .select("id, name")
      .eq("community_id", communityId)
      .is("archived_at", null)
      .order("created_at"),
    loadLegacySpend(communityId, {
      from: `${quarterStartMonth(monthOf(range.start))}-01`,
      to: range.end.slice(0, 10),
    }),
    loadLegacyReceipts(communityId, {
      from: range.start.slice(0, 10),
      to: range.end.slice(0, 10),
    }),
    loadLegacyWallets(communityId),
    db.from("funding_sources").select("id, name").eq("community_id", communityId).order("name"),
    loadCommunityConversions(communityId),
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
  const floats = rows<{ id: string; name: string }>(floatWalletRows, "load dashboard float wallets");
  // Collapse multi-token receipt lines into one FlowIncomingRow per receipt day
  // (amount_lovelace + assets), matching how chain inflows are shaped.
  const receiptFlows = new Map<string, FlowIncomingRow>();
  for (const row of legacyReceiptRows) {
    const key = `${row.id.split(":")[0]}`;
    const cur = receiptFlows.get(key) ?? {
      treasuryId: row.legacyWalletId,
      fromTreasuryId: null,
      fromFloatWalletId: null,
      incomingType: row.fundingSourceId ? "contribution" : "unclassified",
      amountLovelace: "0",
      assets: {} as Record<string, string>,
      blockTime: `${row.receivedOn}T00:00:00.000Z`,
      fundingSourceId: row.fundingSourceId,
    };
    if (row.unit === LOVELACE) {
      cur.amountLovelace = (BigInt(cur.amountLovelace) + BigInt(row.amount)).toString();
    } else {
      cur.assets = { ...cur.assets, [row.unit]: row.amount };
    }
    receiptFlows.set(key, cur);
  }

  const flows: FlowIncomingRow[] = [
    ...flowRows.map((row) => ({
      treasuryId: row.treasury_id,
      fromTreasuryId: row.from_treasury_id,
      fromFloatWalletId: row.from_float_wallet_id,
      incomingType: row.incoming_type,
      amountLovelace: row.amount_lovelace,
      assets: row.assets,
      blockTime: row.block_time,
      fundingSourceId: row.funding_source_id,
    })),
    // Treasury → float: the float's tagged inflow is the amount source (like
    // the receiver side of an internal treasury transfer).
    ...floatFlowRows.map((row) => ({
      treasuryId: row.float_wallet_id,
      fromTreasuryId: row.from_treasury_id,
      fromFloatWalletId: null as string | null,
      incomingType: "transfer",
      amountLovelace: row.amount_lovelace,
      assets: row.assets,
      blockTime: row.block_time,
      fundingSourceId: null as string | null,
    })),
    ...[...receiptFlows.values()].map((row) => ({
      ...row,
      assets: Object.keys(row.assets ?? {}).length > 0 ? row.assets : null,
    })),
  ];

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
  const monthSet = new Set(window.months);
  const conversionFees = sumConversionFees(
    conversions
      .filter((c) => c.block_time && monthSet.has(bucketKey(c.block_time, window.bucket)))
      .flatMap((c) => c.fees.map((f) => ({
        amount: f.amount,
        assetLabel: f.asset_label,
        chain: f.chain,
      }))),
  );
  return {
    series: { ...aggregateDashboardSeries(payouts, refunds, window), treasuries },
    flows: { months: aggregateFlows(flows, window) },
    legacy: {
      wallets: legacyWallets.map((wallet) => ({ id: wallet.id, name: wallet.name })),
      assets: [...assets.values()],
    },
    floats,
    fundingSources: rows<{ id: string; name: string }>(fundingRows, "load funding sources"),
    conversionFees,
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
