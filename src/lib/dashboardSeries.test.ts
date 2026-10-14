import { describe, expect, it } from "vitest";
import type { BudgetSummary, DashboardSeries } from "@/lib/api/types";
import { budgetPeriod, monthOf } from "@/lib/budgets";
import {
  aggregateDashboardSeries,
  allTimeWindow,
  bucketKey,
  bucketLabel,
  budgetTableRows,
  budgetTableTotals,
  chartNumber,
  chartUnits,
  contributorsTasksRows,
  dashboardWindow,
  MAX_MONTH_BARS,
  monthBucket,
  monthsForOwner,
  periodForOwner,
  spendingMonth,
  tokenOptions,
  tokenOrder,
  treasurySpendingRows,
  workgroupSpendingRows,
  type SeriesPayout,
} from "./dashboardSeries";

const ADA = { ticker: "ADA", decimals: 6 };
const T1 = "treasury-1";
const T2 = "treasury-2";

function payout(overrides: Partial<SeriesPayout>): SeriesPayout {
  return {
    taskId: "task-1", contributorWallet: "addr1", ownerType: "workgroup", ownerId: "wg-a", treasuryId: T1,
    unit: "lovelace", amount: "1000000", month: "2026-09", ...overrides,
  };
}

/** A manual payment: no task, charged to the paying treasury's own budget. */
function payment(overrides: Partial<SeriesPayout>): SeriesPayout {
  return payout({ taskId: null, ownerType: "treasury", ownerId: T1, treasuryId: T1, contributorWallet: "addr_outside", ...overrides });
}

describe("dashboard window", () => {
  it("ends at the selected month and spans a year boundary", () => {
    const window = dashboardWindow("2026-02", "month");
    expect(window.months).toHaveLength(12);
    expect(window.months[0]).toBe("2025-03");
    expect(window.months[11]).toBe("2026-02");
    expect(window.selected).toEqual(["2026-02"]);
    expect(window.start).toBe("2025-03-01T00:00:00.000Z");
    expect(window.end).toBe("2026-03-01T00:00:00.000Z");
  });

  it("ends at the last month of the selected quarter", () => {
    const window = dashboardWindow("2026-08", "quarter");
    expect(window.selected).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(window.months[11]).toBe("2026-09");
    expect(window.end).toBe("2026-10-01T00:00:00.000Z");
  });

  it("covers all time month by month from the first activity, with every bucket selected", () => {
    const window = allTimeWindow("2025-11", "2026-02");
    expect(window.months).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(window.selected).toEqual(window.months);
    expect(window.bucket).toBe("month");
    expect(window.start).toBe("2025-11-01T00:00:00.000Z");
    expect(window.end).toBe("2026-03-01T00:00:00.000Z");
    expect(allTimeWindow("2024-03", "2026-02").months).toHaveLength(MAX_MONTH_BARS);
  });

  it("switches all time to quarter buckets past two years, and to the trailing year without activity", () => {
    const window = allTimeWindow("2024-02", "2026-02");
    expect(window.bucket).toBe("quarter");
    expect(window.months[0]).toBe("2024-01");
    expect(window.months[window.months.length - 1]).toBe("2026-01");
    expect(window.months).toHaveLength(9);
    expect(window.start).toBe("2024-01-01T00:00:00.000Z");
    expect(window.end).toBe("2026-03-01T00:00:00.000Z");
    expect(bucketKey("2025-06-30T23:00:00Z", "quarter")).toBe("2025-04");
    expect(bucketLabel("2025-04", "quarter")).toBe("Q2 2025");
    expect(bucketLabel("2025-04", "month")).toBe("Apr 2025");
    expect(allTimeWindow(null, "2026-02")).toEqual(dashboardWindow("2026-02", "month"));
  });

  it("buckets instants by UTC month", () => {
    expect(monthOf("2026-09-01")).toBe("2026-09");
    expect(monthOf("2026-09-01T01:00:00+02:00")).toBe("2026-08");
    expect(monthOf("2026-09-30T23:59:59Z")).toBe("2026-09");
  });

  it("scales amounts for geometry only", () => {
    expect(chartNumber("1500000", 6)).toBe(1.5);
    expect(chartNumber("-250000", 6)).toBe(-0.25);
    expect(chartNumber("7", 0)).toBe(7);
  });
});

describe("spendingMonth", () => {
  const paidAt = "2026-09-28T10:00:00Z";

  it("keeps a monthly task in its budget month however late or early it was paid", () => {
    expect(spendingMonth({ budgetMonth: "2026-05-01", paidAt, cadence: "monthly" })).toBe("2026-05");
    expect(spendingMonth({ budgetMonth: "2026-11-01", paidAt, cadence: "monthly" })).toBe("2026-11");
  });

  it("places a quarterly task in the month it was paid, clamped into the quarter", () => {
    expect(spendingMonth({ budgetMonth: "2026-07-01", paidAt: "2026-08-15T00:00:00Z", cadence: "quarterly" })).toBe("2026-08");
    expect(spendingMonth({ budgetMonth: "2026-07-01", paidAt, cadence: "quarterly" })).toBe("2026-09");
    // Paid after the quarter: its last month; before it: its first.
    expect(spendingMonth({ budgetMonth: "2026-04-01", paidAt, cadence: "quarterly" })).toBe("2026-06");
    expect(spendingMonth({ budgetMonth: "2026-10-01", paidAt, cadence: "quarterly" })).toBe("2026-10");
  });

  it("falls back to the payment month without a period, and to the stored month without a setup", () => {
    expect(spendingMonth({ budgetMonth: null, paidAt, cadence: null })).toBe("2026-09");
    expect(spendingMonth({ budgetMonth: "2026-07-01", paidAt, cadence: null })).toBe("2026-07");
  });
});

describe("aggregateDashboardSeries", () => {
  const window = dashboardWindow("2026-09", "quarter");

  it("spreads one batch over the budget months it paid", () => {
    const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
    const series = aggregateDashboardSeries(
      months.map((month, index) => payout({ taskId: `t${index}`, month })), [], window);
    for (const month of months) {
      expect(series.months.find((m) => m.month === month)).toMatchObject({ contributors: 1, tasks: 1 });
    }
  });

  it("counts contributors and tasks once per month and per workgroup", () => {
    const series = aggregateDashboardSeries([
      payout({ taskId: "t1", contributorWallet: "w1", ownerId: "wg-a" }),
      payout({ taskId: "t1", contributorWallet: "w2", ownerId: "wg-a", amount: "2000000" }),
      payout({ taskId: "t2", contributorWallet: "w1", ownerId: "wg-b", unit: "tok", amount: "5" }),
      payout({ taskId: "t3", contributorWallet: "w1", ownerId: "wg-a", month: "2026-08" }),
    ], [], window);
    const september = series.months.find((m) => m.month === "2026-09")!;
    expect(september.contributors).toBe(2);
    expect(september.tasks).toBe(2);
    expect(september.byOwner).toEqual([
      { ownerType: "workgroup", ownerId: "wg-a", contributors: 2, tasks: 1, spending: [{ treasuryId: T1, unit: "lovelace", amount: "3000000" }] },
      { ownerType: "workgroup", ownerId: "wg-b", contributors: 1, tasks: 1, spending: [{ treasuryId: T1, unit: "tok", amount: "5" }] },
    ]);
    const august = series.months.find((m) => m.month === "2026-08")!;
    expect(august).toMatchObject({ contributors: 1, tasks: 1 });
    // The quarter counts wallets and tasks once across its months.
    expect(series.period).toEqual({
      contributors: 2, tasks: 3,
      byOwner: [
        { ownerType: "workgroup", ownerId: "wg-a", contributors: 2, tasks: 2 },
        { ownerType: "workgroup", ownerId: "wg-b", contributors: 1, tasks: 1 },
      ],
    });
  });

  it("adds manual payments as treasury spending without counting contributors or tasks", () => {
    const series = aggregateDashboardSeries([
      payout({ taskId: "t1", contributorWallet: "w1" }),
      payment({ amount: "2500000" }),
      payment({ amount: "500000", unit: "tok" }),
      payment({ ownerId: T2, treasuryId: T2, amount: "100" }),
    ], [], window);
    const september = series.months.find((m) => m.month === "2026-09")!;
    expect(september).toMatchObject({ contributors: 1, tasks: 1 });
    expect(september.byOwner).toEqual([
      { ownerType: "treasury", ownerId: T1, contributors: 0, tasks: 0, spending: [
        { treasuryId: T1, unit: "lovelace", amount: "2500000" }, { treasuryId: T1, unit: "tok", amount: "500000" },
      ] },
      { ownerType: "treasury", ownerId: T2, contributors: 0, tasks: 0, spending: [{ treasuryId: T2, unit: "lovelace", amount: "100" }] },
      { ownerType: "workgroup", ownerId: "wg-a", contributors: 1, tasks: 1, spending: [{ treasuryId: T1, unit: "lovelace", amount: "1000000" }] },
    ]);
    expect(series.period.byOwner.find((owner) => owner.ownerId === T1)).toEqual({ ownerType: "treasury", ownerId: T1, contributors: 0, tasks: 0 });
  });

  it("nets refunds in their own month and ignores rows outside the window", () => {
    const series = aggregateDashboardSeries([
      payout({ amount: "4000000" }),
      payout({ taskId: "old", month: "2024-01" }),
    ], [
      { ownerId: "wg-a", treasuryId: T1, unit: "lovelace", amount: "1000000", createdAt: "2026-09-20T00:00:00Z" },
      { ownerId: "wg-a", treasuryId: T1, unit: "lovelace", amount: "500000", createdAt: "2026-10-05T00:00:00Z" },
    ], window);
    const september = series.months.find((m) => m.month === "2026-09")!;
    expect(september.byOwner[0]!.spending).toEqual([{ treasuryId: T1, unit: "lovelace", amount: "3000000" }]);
    expect(series.months.every((m) => m.month >= "2025-10")).toBe(true);
    expect(series.period.tasks).toBe(1);
  });

  it("counts a contributor once per quarter bucket and over all time", () => {
    const series = aggregateDashboardSeries([
      payout({ taskId: "t1", contributorWallet: "w1", month: "2024-04" }),
      payout({ taskId: "t2", contributorWallet: "w1", month: "2024-06" }),
      payout({ taskId: "t3", contributorWallet: "w1", month: "2026-09" }),
    ], [], allTimeWindow("2024-04", "2026-09"));
    expect(series.bucket).toBe("quarter");
    expect(series.months[0]).toMatchObject({ month: "2024-04", contributors: 1, tasks: 2 });
    expect(series.months[0]!.byOwner[0]!.spending).toEqual([{ treasuryId: T1, unit: "lovelace", amount: "2000000" }]);
    expect(series.period).toMatchObject({ contributors: 1, tasks: 3 });
    const rows = contributorsTasksRows(monthsForOwner({ ...series, treasuries: [] }, "all"), [], series.bucket);
    expect(rows[0]).toMatchObject({ label: "Q2 2024", selected: false });
  });

  it("sums beyond the float range exactly and drops cells that net to zero", () => {
    const big = "9007199254740993";
    const series = aggregateDashboardSeries([
      payout({ amount: big }),
      payout({ taskId: "t2", amount: big }),
      payout({ taskId: "t3", unit: "tok", amount: "10" }),
    ], [
      { ownerId: "wg-a", treasuryId: T1, unit: "tok", amount: "10", createdAt: "2026-09-21T00:00:00Z" },
    ], window);
    const september = series.months.find((m) => m.month === "2026-09")!;
    expect(september.byOwner[0]!.spending).toEqual([{ treasuryId: T1, unit: "lovelace", amount: "18014398509481986" }]);
  });
});

describe("chart rows", () => {
  const window = dashboardWindow("2026-09", "month");
  const series: DashboardSeries = {
    ...aggregateDashboardSeries([
      payout({ taskId: "t1", contributorWallet: "w1", ownerId: "wg-a", treasuryId: T1, amount: "1000000" }),
      payout({ taskId: "t2", contributorWallet: "w2", ownerId: "wg-b", treasuryId: T2, amount: "2500000" }),
      payout({ taskId: "t3", contributorWallet: "w1", ownerId: "wg-b", treasuryId: T2, amount: "1000000", month: "2026-08" }),
    ], [], window),
    treasuries: [{ id: T1, name: "Main" }, { id: T2, name: "Grants" }, { id: "idle", name: "Idle" }],
  };

  it("narrows the window to one owner or merges every owner", () => {
    const all = monthsForOwner(series, "all");
    expect(all.find((m) => m.month === "2026-09")).toEqual({
      month: "2026-09", contributors: 2, tasks: 2,
      spending: [
        { treasuryId: T1, unit: "lovelace", amount: "1000000" },
        { treasuryId: T2, unit: "lovelace", amount: "2500000" },
      ],
    });
    const b = monthsForOwner(series, "wg-b");
    expect(b.find((m) => m.month === "2026-09")).toMatchObject({ contributors: 1, tasks: 1 });
    expect(b.find((m) => m.month === "2026-07")).toEqual({ month: "2026-07", contributors: 0, tasks: 0, spending: [] });
    expect(periodForOwner(series, "all")).toEqual({ contributors: 2, tasks: 2 });
    expect(periodForOwner(series, "wg-b")).toEqual({ contributors: 1, tasks: 1 });
    expect(periodForOwner(series, "missing")).toEqual({ contributors: 0, tasks: 0 });
  });

  it("labels months and marks the selected one", () => {
    const rows = contributorsTasksRows(monthsForOwner(series, "all"), window.selected);
    expect(rows).toHaveLength(12);
    expect(rows[11]).toEqual({
      key: "2026-09", label: "Sep 2026", selected: true,
      values: { contributors: 2, tasks: 2 }, labels: { contributors: "2", tasks: "2" },
    });
    expect(rows[10]!.selected).toBe(false);
  });

  it("stacks spending by treasury, leaving idle treasuries out", () => {
    const { rows, series: stacks } = treasurySpendingRows(monthsForOwner(series, "all"), "lovelace", ADA, series.treasuries, window.selected);
    expect(stacks).toEqual([{ key: T1, name: "Main" }, { key: T2, name: "Grants" }]);
    expect(rows[11]).toEqual({
      key: "2026-09", label: "Sep 2026", selected: true,
      values: { total: 3.5, [T1]: 1, [T2]: 2.5 },
      labels: { total: "3.5 ADA", [T1]: "1 ADA", [T2]: "2.5 ADA" },
    });
    expect(rows[10]!.values).toEqual({ total: 1, [T1]: 0, [T2]: 1 });
  });

  it("counts previous-wallet history as workgroup spend, tasks and contributors", () => {
    const legacy = aggregateDashboardSeries([
      payout({ taskId: "t1", contributorWallet: "w1", ownerId: "wg-a", treasuryId: T1, amount: "1000000" }),
      // Imported lines: a history task key, the previous wallet in the treasury
      // slot. One task paid to two people is two lines; w1 is a known member.
      payout({ taskId: "legacy:wg-a|2026-09-15|docs", contributorWallet: "w1", ownerId: "wg-a", treasuryId: "old-wallet", amount: "2000000" }),
      payout({ taskId: "legacy:wg-a|2026-09-15|docs", contributorWallet: "legacy:f39ntm", ownerId: "wg-a", treasuryId: "old-wallet", amount: "2000000" }),
    ], [], window);
    const months = monthsForOwner({ ...legacy, treasuries: [] }, "wg-a");
    expect(months.find((m) => m.month === "2026-09")).toEqual({
      month: "2026-09", contributors: 2, tasks: 2,
      spending: [
        { treasuryId: "old-wallet", unit: "lovelace", amount: "4000000" },
        { treasuryId: T1, unit: "lovelace", amount: "1000000" },
      ],
    });
    const sources = [{ id: T1, name: "Main" }, { id: "old-wallet", name: "Old (previous wallet)" }];
    const { rows, series: stacks } = treasurySpendingRows(months, "lovelace", ADA, sources, window.selected);
    expect(stacks).toEqual([{ key: T1, name: "Main" }, { key: "old-wallet", name: "Old (previous wallet)" }]);
    expect(rows[11]!.values).toEqual({ total: 5, [T1]: 1, "old-wallet": 4 });
  });

  it("folds treasuries past the cap into one stack", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, name: `Treasury ${i}` }));
    const months = [{
      month: "2026-09", contributors: 1, tasks: 1,
      spending: many.map((t, i) => ({ treasuryId: t.id, unit: "lovelace", amount: String((i + 1) * 1000000) })),
    }];
    const { rows, series: stacks } = treasurySpendingRows(months, "lovelace", ADA, many, ["2026-09"]);
    expect(stacks.map((s) => s.key)).toEqual(["t0", "t1", "t2", "other"]);
    expect(rows[0]!.labels.other).toBe("15 ADA");
    expect(rows[0]!.labels.total).toBe("21 ADA");
  });
});

describe("budget table", () => {
  const month = budgetPeriod("monthly", new Date("2026-09-01T00:00:00Z"));
  const quarter = budgetPeriod("quarterly", new Date("2026-09-01T00:00:00Z"));
  const names = new Map([["wg-a", "Alpha"], ["wg-b", "Beta"], ["wg-c", "Gamma"]]);

  function budget(overrides: Partial<BudgetSummary>): BudgetSummary {
    return {
      id: "b", budgetMonth: "2026-09", ownerType: "workgroup", ownerId: "wg-a", ownerName: "Alpha", treasuryId: null,
      workgroupKind: "workgroup", cadence: "monthly", unit: "lovelace", assetLabel: "ADA", decimals: 6,
      amount: "10000000", spent: "4000000", balance: "6000000",
      periodStart: month.start, periodEnd: month.end, periodLabel: month.label, ...overrides,
    };
  }

  it("merges a monthly project's months into its quarter row and keeps a quarterly project's own period", () => {
    const rows = budgetTableRows({
      budgets: [
        budget({ id: "1", periodLabel: "July 2026", amount: "1000000", spent: "100000", balance: "900000" }),
        budget({ id: "2", periodLabel: "August 2026", amount: "1000000", spent: "200000", balance: "800000" }),
        budget({ id: "3", periodLabel: "September 2026", amount: "1000000", spent: "300000", balance: "700000" }),
        budget({ id: "4", ownerId: "wg-b", ownerName: "Beta", cadence: "quarterly", periodLabel: quarter.label,
          amount: "9000000", spent: "9500000", balance: "-500000" }),
      ],
      spending: [], refunds: [], period: quarter, view: "quarter", names,
    });
    expect(rows).toEqual([
      { key: "wg-a:lovelace", ownerType: "workgroup", ownerId: "wg-a", ownerName: "Alpha", unit: "lovelace",
        amount: "3000000", spent: "600000", balance: "2400000", periodLabel: null },
      { key: "wg-b:lovelace", ownerType: "workgroup", ownerId: "wg-b", ownerName: "Beta", unit: "lovelace",
        amount: "9000000", spent: "9500000", balance: "-500000", periodLabel: null },
    ]);
    // Seen by month, the quarterly project names its quarter.
    const byMonth = budgetTableRows({
      budgets: [budget({ ownerId: "wg-b", ownerName: "Beta", cadence: "quarterly", periodLabel: quarter.label })],
      spending: [], refunds: [], period: month, view: "month", names,
    });
    expect(byMonth[0]!.periodLabel).toBe("Q3 2026");
  });

  it("adds no-budget rows from spending in the period, netting refunds, and totals per token", () => {
    const line = (overrides: Partial<BudgetSummary> & { id: string; title: string; unit: string; amount: string; createdAt: string }) => ({
      kind: "payout" as const, ownerType: "workgroup" as const, ownerId: "wg-c", ownerName: "Workgroup", status: "confirmed", ...overrides,
    });
    const rows = budgetTableRows({
      budgets: [budget({})],
      spending: [
        line({ id: "s1", title: "x", unit: "lovelace", amount: "2000000", createdAt: "2026-09-01T00:00:00.000Z" }),
        line({ id: "s2", title: "y", unit: "tok", amount: "30", createdAt: "2026-09-01T00:00:00.000Z" }),
        line({ id: "s3", title: "z", unit: "lovelace", amount: "5000000", createdAt: "2026-08-01T00:00:00.000Z" }),
        line({ id: "s4", ownerId: "wg-a", ownerName: "Alpha", title: "w", unit: "lovelace", amount: "999", createdAt: "2026-09-01T00:00:00.000Z" }),
        // A treasury's direct payment without a budget gets its own row, named by the caller's map or its label.
        { id: "p1", kind: "payment" as const, ownerType: "treasury" as const, ownerId: T1, ownerName: "Treasury: Main",
          title: "addr…1", unit: "lovelace", amount: "700000", status: "submitted", createdAt: "2026-09-01T00:00:00.000Z" },
      ],
      refunds: [
        { ownerId: "wg-c", unit: "lovelace", amount: "500000", createdAt: "2026-09-15T00:00:00Z" },
        { ownerId: "wg-c", unit: "tok", amount: "30", createdAt: "2026-09-15T00:00:00Z" },
      ],
      period: month, view: "month", names,
    });
    expect(rows.map((row) => [row.ownerName, row.ownerType, row.unit, row.amount, row.spent, row.balance])).toEqual([
      ["Alpha", "workgroup", "lovelace", "10000000", "4000000", "6000000"],
      ["Gamma", "workgroup", "lovelace", null, "1500000", null],
      ["Treasury: Main", "treasury", "lovelace", null, "700000", null],
    ]);
    expect(budgetTableTotals(rows)).toEqual([
      { unit: "lovelace", amount: "10000000", spent: "6200000", balance: "3800000" },
    ]);
    expect(budgetTableTotals(rows.slice(1))).toEqual([
      { unit: "lovelace", amount: null, spent: "2200000", balance: null },
    ]);
  });

  it("sums an owner's periods for all time and counts spending outside any budgeted period", () => {
    const line = (id: string, ownerId: string, amount: string, createdAt: string) => ({
      id, kind: "payout" as const, ownerType: "workgroup" as const, ownerId, ownerName: "Workgroup",
      title: id, unit: "lovelace", amount, status: "confirmed", createdAt,
    });
    const rows = budgetTableRows({
      budgets: [
        budget({ id: "1", periodLabel: "August 2026", amount: "1000000", spent: "200000", balance: "800000" }),
        budget({ id: "2", periodLabel: "September 2026", amount: "1000000", spent: "300000", balance: "700000" }),
        budget({ id: "3", ownerId: "wg-b", ownerName: "Beta", cadence: "quarterly", periodLabel: quarter.label,
          amount: "9000000", spent: "0", balance: "9000000" }),
      ],
      spending: [
        line("s1", "wg-a", "200000", "2026-08-01T00:00:00.000Z"),
        line("s2", "wg-a", "300000", "2026-09-01T00:00:00.000Z"),
        // Paid before Alpha had a budget: part of all time, in no budget's `spent`.
        line("s3", "wg-a", "4000000", "2025-01-01T00:00:00.000Z"),
        line("s4", "wg-c", "50", "2024-06-01T00:00:00.000Z"),
      ],
      refunds: [
        { ownerId: "wg-a", unit: "lovelace", amount: "1000000", createdAt: "2025-02-01T00:00:00Z" },
        { ownerId: "wg-b", unit: "lovelace", amount: "7", createdAt: "2025-02-01T00:00:00Z" },
      ],
      period: null, view: "all", names,
    });
    expect(rows.map((row) => [row.ownerName, row.amount, row.spent, row.balance, row.periodLabel])).toEqual([
      ["Alpha", "2000000", "3500000", "-1500000", null],
      // A refund never takes spending below zero.
      ["Beta", "9000000", "0", "9000000", null],
      ["Gamma", null, "50", null, null],
    ]);
  });

  it("charts the budgeted tokens, main token first, or the main token alone", () => {
    const budgets = [
      budget({ unit: "zzz", assetLabel: "AAA" }),
      budget({ unit: "tok", assetLabel: "TOK" }),
      budget({ ownerId: "wg-b", unit: "tok", assetLabel: "TOK" }),
      budget({}),
    ];
    expect(chartUnits([], "tok")).toEqual(["tok"]);
    expect(chartUnits([], "lovelace")).toEqual(["lovelace"]);
    expect(chartUnits(budgets, "tok")).toEqual(["tok", "lovelace", "zzz"]);
    // Without a main token among the budgets: ADA, then the rest by label.
    expect(chartUnits(budgets, "lovelace")).toEqual(["lovelace", "zzz", "tok"]);
    expect(chartUnits(budgets, "other")).toEqual(["lovelace", "zzz", "tok"]);
    // A token chosen in the filter narrows the set to itself.
    expect(chartUnits(budgets, "tok", "zzz")).toEqual(["zzz"]);
  });

  it("lists tokens main token first in rows, totals and options", () => {
    const rows = budgetTableRows({
      budgets: [
        budget({ unit: "tok", assetLabel: "TOK", decimals: 0, amount: "10", spent: "0", balance: "10" }),
        budget({}),
        budget({ ownerId: "wg-b", ownerName: "Beta", unit: "zzz", assetLabel: "ZZZ", decimals: 0, amount: "1", spent: "1", balance: "0" }),
      ],
      spending: [], refunds: [], period: month, view: "month", names, mainUnit: "tok",
    });
    expect(rows.map((row) => row.key)).toEqual(["wg-a:tok", "wg-a:lovelace", "wg-b:zzz"]);
    expect(budgetTableTotals(rows, "tok").map((total) => total.unit)).toEqual(["tok", "lovelace", "zzz"]);
    const series: DashboardSeries = { months: [], bucket: "month", period: { contributors: 0, tasks: 0, byOwner: [] }, treasuries: [] };
    // The main token is always offered, budgeted or not.
    expect(tokenOptions([budget({})], [], series, "tok")).toEqual(["tok", "lovelace"]);
  });

  it("orders owner spending bars by amount and lists tokens ADA first", () => {
    const rows = budgetTableRows({
      budgets: [
        budget({ ownerId: "wg-a", ownerName: "Alpha", spent: "1000000" }),
        budget({ ownerId: "wg-b", ownerName: "Beta", spent: "7000000", balance: "3000000" }),
        budget({ ownerId: "wg-c", ownerName: "Gamma", unit: "tok", assetLabel: "TOK", decimals: 0, amount: "10", spent: "0", balance: "10" }),
        budget({ ownerType: "treasury", ownerId: T1, ownerName: "Treasury: Main", treasuryId: T1, workgroupKind: null,
          spent: "3000000", balance: "7000000" }),
      ],
      spending: [], refunds: [], period: month, view: "month", names,
    });
    expect(workgroupSpendingRows(rows, "lovelace", ADA).map((row) => [row.label, row.values.spent, row.labels.spent, row.labels.budget])).toEqual([
      ["Beta", 7, "7 ADA", "10 ADA"],
      ["Treasury: Main", 3, "3 ADA", "10 ADA"],
      ["Alpha", 1, "1 ADA", "10 ADA"],
    ]);
    expect(workgroupSpendingRows(rows, "tok", { ticker: "TOK", decimals: 0 })).toHaveLength(1);
    const series: DashboardSeries = { months: [{ month: "2026-09", contributors: 0, tasks: 0,
      byOwner: [{ ownerType: "workgroup", ownerId: "wg-a", contributors: 0, tasks: 0, spending: [{ treasuryId: T1, unit: "zzz", amount: "1" }] }] }],
      bucket: "month", period: { contributors: 0, tasks: 0, byOwner: [] }, treasuries: [] };
    expect(tokenOptions(rows.map((row) => budget({ unit: row.unit })), [], series)).toEqual(["lovelace", "tok", "zzz"]);
  });
});

describe("monthBucket", () => {
  it("is the month itself in a monthly window", () => {
    for (const month of ["2026-01", "2026-08", "2026-12"]) expect(monthBucket(month, "month")).toBe(month);
  });

  it("is the first month of the quarter in a quarterly window", () => {
    expect(["2026-01", "2026-02", "2026-03"].map((m) => monthBucket(m, "quarter"))).toEqual(["2026-01", "2026-01", "2026-01"]);
    expect(["2026-04", "2026-06", "2026-07", "2026-09"].map((m) => monthBucket(m, "quarter"))).toEqual(["2026-04", "2026-04", "2026-07", "2026-07"]);
    expect(["2026-10", "2026-12"].map((m) => monthBucket(m, "quarter"))).toEqual(["2026-10", "2026-10"]);
    // A quarter never crosses the year.
    expect(monthBucket("2027-01", "quarter")).toBe("2027-01");
  });

  it("agrees with bucketKey for an instant of that month", () => {
    expect(bucketKey("2026-08-31T23:59:59Z", "quarter")).toBe(monthBucket("2026-08", "quarter"));
    expect(bucketKey("2026-08-31T23:59:59Z", "month")).toBe(monthBucket("2026-08", "month"));
  });
});

describe("tokenOrder", () => {
  const MAIN = "policy-main";
  const A = "policy-a";
  const B = "policy-b";

  it("puts the main token first, then ADA, then the rest by unit", () => {
    expect([B, "lovelace", A, MAIN].sort(tokenOrder(MAIN))).toEqual([MAIN, "lovelace", A, B]);
    expect([A, B, "lovelace"].sort(tokenOrder(MAIN))).toEqual(["lovelace", A, B]);
  });

  it("puts ADA first when it is the main token", () => {
    expect([B, A, "lovelace"].sort(tokenOrder("lovelace"))).toEqual(["lovelace", A, B]);
  });

  it("orders the rest by ticker, not by unit, when given the tickers", () => {
    const tickers: Record<string, string> = { [A]: "ZEBRA", [B]: "AGIX" };
    const order = tokenOrder(MAIN, (unit) => tickers[unit] ?? unit);
    expect([A, B, "lovelace", MAIN].sort(order)).toEqual([MAIN, "lovelace", B, A]);
  });

  it("breaks a tie between equal tickers by unit, so the order is stable across runs", () => {
    const order = tokenOrder(MAIN, () => "SAME");
    expect([B, A].sort(order)).toEqual([A, B]);
    expect([A, B].sort(order)).toEqual([A, B]);
  });

  it("is a consistent comparator: zero for the same unit, antisymmetric otherwise", () => {
    const order = tokenOrder(MAIN);
    for (const unit of [MAIN, "lovelace", A]) expect(order(unit, unit)).toBe(0);
    for (const [a, b] of [[MAIN, "lovelace"], [MAIN, A], ["lovelace", A], [A, B]] as const) {
      expect(order(a, b)).toBeLessThan(0);
      expect(order(b, a)).toBeGreaterThan(0);
    }
  });
});
