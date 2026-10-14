import { beforeEach, describe, expect, it, vi } from "vitest";
import { PayoutStatus, TxState } from "@/lib/constants";

const mocks = vi.hoisted(() => ({ from: vi.fn(), legacy: vi.fn() }));
// db/client re-exports this client; its real allRows / rows / relation unwrap the pages.
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/db/legacyHistory", () => ({ loadLegacySpend: mocks.legacy }));

import { loadSpentForTargets, type SpentTarget } from "./spendCheck";

interface Query { table: string; select: string; filters: unknown[][]; ranges: [number, number][] }
let queries: Query[];
/** The rows each table answers on its first page. */
let answers: Record<string, unknown[]>;

function builder(table: string) {
  const q: Query = { table, select: "", filters: [], ranges: [] };
  const filter = (name: string) => (...args: unknown[]) => { q.filters.push([name, ...args]); return chain; };
  const chain = {
    select: (columns: string) => { q.select = columns; return chain; },
    in: filter("in"), or: filter("or"), gte: filter("gte"), lt: filter("lt"),
    order: () => chain,
    range: async (a: number, b: number) => {
      if (q.ranges.length === 0) queries.push(q);
      q.ranges.push([a, b]);
      return { data: a === 0 ? answers[table] ?? [] : [], error: null };
    },
  };
  return chain;
}

const WG = "wg-1";
const OTHER_WG = "wg-2";
const WG_KEY = `w:${WG}`;
const T_KEY = "t:t-1";
const LOVELACE = "lovelace";
const GVTT = `${"a".repeat(56)}47565454`;

const workgroupTarget = (patch: Partial<SpentTarget> = {}): SpentTarget => ({
  ownerKey: WG_KEY, ownerType: "workgroup", ownerId: WG, periodMonth: "2026-10", cadence: "monthly", ...patch,
});
const treasuryTarget = (patch: Partial<SpentTarget> = {}): SpentTarget => ({
  ownerKey: T_KEY, ownerType: "treasury", ownerId: "t-1", periodMonth: "2026-10", cadence: "monthly", ...patch,
});

const payoutRow = (patch: Record<string, unknown> = {}) => ({
  transaction_id: "tx-a", amount: "10000000", unit: LOVELACE, status: PayoutStatus.Confirmed, created_at: "2026-10-03T00:00:00Z",
  tasks: { workgroup_id: WG, budget_month: "2026-10-01" },
  transactions: { state: TxState.Confirmed, submitted_at: "2026-10-03T00:00:00Z" },
  ...patch,
});
const paymentRow = (patch: Record<string, unknown> = {}) => ({
  transaction_id: "tx-p", amount: "4000000", unit: LOVELACE, treasury_id: "t-1", budget_month: "2026-10-01",
  transactions: { state: TxState.Confirmed },
  ...patch,
});
const queryOf = (table: string) => queries.find((q) => q.table === table);
const tables = () => queries.map((q) => q.table);

beforeEach(() => {
  vi.resetAllMocks();
  queries = [];
  answers = {};
  mocks.from.mockImplementation(builder);
  mocks.legacy.mockResolvedValue([]);
});

describe("loadSpentForTargets", () => {
  it("reads nothing without targets", async () => {
    expect(await loadSpentForTargets("c-1", [])).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it("counts a workgroup's confirmed payouts and the rows of pending transactions, less refunds, plus imported history, per unit", async () => {
    answers.payouts = [
      payoutRow(),
      payoutRow({ transaction_id: "tx-b", amount: "5000000", status: PayoutStatus.Pending, transactions: { state: TxState.Pending, submitted_at: null } }),
      // A pending row whose transaction moved on: the poller's status flip is the truth, the row is not counted twice.
      payoutRow({ transaction_id: "tx-c", amount: "7000000", status: PayoutStatus.Pending, transactions: { state: TxState.Submitted, submitted_at: "2026-10-04T00:00:00Z" } }),
      // No budget month: attributed by submission time.
      payoutRow({ transaction_id: "tx-d", amount: "3000000", status: PayoutStatus.Submitted, tasks: { workgroup_id: WG, budget_month: null }, transactions: { state: TxState.Submitted, submitted_at: "2026-10-20T00:00:00Z" } }),
      payoutRow({ transaction_id: "tx-e", amount: "9000000", status: PayoutStatus.Submitted, tasks: { workgroup_id: WG, budget_month: null }, transactions: { state: TxState.Submitted, submitted_at: "2026-09-15T00:00:00Z" } }),
      payoutRow({ transaction_id: "tx-f", amount: "100", unit: GVTT, status: PayoutStatus.WrittenBack }),
      payoutRow({ transaction_id: "tx-g", amount: "50000000", tasks: { workgroup_id: OTHER_WG, budget_month: "2026-10-01" } }),
    ];
    answers.reconciliations = [
      { amount: "2000000", unit: LOVELACE, created_at: "2026-10-05T00:00:00Z", payouts: { tasks: { workgroup_id: WG } } },
      { amount: "8000000", unit: LOVELACE, created_at: "2026-10-05T00:00:00Z", payouts: { tasks: { workgroup_id: OTHER_WG } } },
      { amount: "8000000", unit: LOVELACE, created_at: "2026-11-05T00:00:00Z", payouts: { tasks: { workgroup_id: WG } } },
    ];
    mocks.legacy.mockResolvedValue([
      { workgroupId: WG, budgetMonth: "2026-10-01", unit: LOVELACE, amount: "1000000" },
      { workgroupId: WG, budgetMonth: "2026-09-01", unit: LOVELACE, amount: "1000000" },
      { workgroupId: OTHER_WG, budgetMonth: "2026-10-01", unit: LOVELACE, amount: "1000000" },
    ]);

    const spent = await loadSpentForTargets("c-1", [workgroupTarget()]);

    // 10 confirmed + 5 pending + 3 submitted - 2 refunded + 1 imported; the token apart.
    expect(spent).toEqual([
      { ownerKey: WG_KEY, periodMonth: "2026-10", unit: LOVELACE, amount: 17_000_000n },
      { ownerKey: WG_KEY, periodMonth: "2026-10", unit: GVTT, amount: 100n },
    ]);
    expect(tables()).toEqual(["payouts", "reconciliations"]);
    expect(queryOf("payouts")).toMatchObject({
      select: expect.stringContaining("tasks!inner(workgroup_id, budget_month), transactions!inner(state, submitted_at)"),
      filters: [
        ["in", "tasks.workgroup_id", [WG]],
        ["in", "transactions.state", [TxState.Pending, TxState.Submitted, TxState.Confirmed]],
        ["or", "budget_month.is.null,and(budget_month.gte.2026-10-01,budget_month.lt.2026-11-01)", { referencedTable: "tasks" }],
      ],
      ranges: [[0, 499]],
    });
    expect(queryOf("reconciliations")).toMatchObject({
      filters: [
        ["in", "payouts.tasks.workgroup_id", [WG]],
        ["gte", "created_at", "2026-10-01T00:00:00.000Z"],
        ["lt", "created_at", "2026-11-01T00:00:00.000Z"],
      ],
    });
    expect(mocks.legacy).toHaveBeenCalledExactlyOnceWith("c-1", { from: "2026-10-01", to: "2026-11-01" });
  });

  it("leaves the excluded transaction's own rows out, for payouts and payments alike", async () => {
    answers.payouts = [
      payoutRow(),
      payoutRow({ transaction_id: "tx-self", amount: "5000000", status: PayoutStatus.Pending, transactions: { state: TxState.Pending, submitted_at: null } }),
    ];
    answers.payments = [paymentRow(), paymentRow({ transaction_id: "tx-self", amount: "6000000", transactions: { state: TxState.Pending } })];

    expect(await loadSpentForTargets("c-1", [workgroupTarget(), treasuryTarget()], { excludeTransactionId: "tx-self" })).toEqual([
      { ownerKey: WG_KEY, periodMonth: "2026-10", unit: LOVELACE, amount: 10_000_000n },
      { ownerKey: T_KEY, periodMonth: "2026-10", unit: LOVELACE, amount: 4_000_000n },
    ]);
    expect(tables()).toEqual(["payouts", "reconciliations", "payments"]);
  });

  it("counts a treasury's manual payments of the period, pending ones included, and never a transfer", async () => {
    answers.payments = [
      paymentRow(),
      paymentRow({ transaction_id: "tx-q", amount: "2000000", transactions: { state: TxState.Pending } }),
      paymentRow({ transaction_id: "tx-r", amount: "70", unit: GVTT, transactions: { state: TxState.Submitted } }),
      paymentRow({ transaction_id: "tx-s", amount: "9000000", treasury_id: "t-2" }),
      paymentRow({ transaction_id: "tx-t", amount: "9000000", budget_month: "2026-11-01" }),
      // A transfer row, should a query change ever let one through: ignored, not a crash.
      paymentRow({ transaction_id: "tx-u", amount: "9000000", budget_month: null }),
    ];

    expect(await loadSpentForTargets("c-1", [treasuryTarget()])).toEqual([
      { ownerKey: T_KEY, periodMonth: "2026-10", unit: LOVELACE, amount: 6_000_000n },
      { ownerKey: T_KEY, periodMonth: "2026-10", unit: GVTT, amount: 70n },
    ]);
    // No workgroup: no payouts, refunds or history are read.
    expect(tables()).toEqual(["payments"]);
    expect(mocks.legacy).not.toHaveBeenCalled();
    // A transfer has no budget month, so the period range leaves it out; a rejected transaction's rows never count.
    expect(queryOf("payments")).toMatchObject({
      filters: [
        ["in", "treasury_id", ["t-1"]],
        ["in", "transactions.state", [TxState.Pending, TxState.Submitted, TxState.Confirmed]],
        ["gte", "budget_month", "2026-10-01"],
        ["lt", "budget_month", "2026-11-01"],
      ],
    });
  });

  it("groups by owner key, period and unit across several targets, reading one window that spans them all", async () => {
    answers.payouts = [
      payoutRow(),
      payoutRow({ transaction_id: "tx-h", amount: "2000000", tasks: { workgroup_id: WG, budget_month: "2026-12-01" } }),
      payoutRow({ transaction_id: "tx-i", amount: "4000000", tasks: { workgroup_id: OTHER_WG, budget_month: "2026-12-01" } }),
      payoutRow({ transaction_id: "tx-j", amount: "8000000", tasks: { workgroup_id: OTHER_WG, budget_month: "2026-10-01" } }),
    ];
    answers.payments = [paymentRow({ budget_month: "2026-11-01" })];

    const spent = await loadSpentForTargets("c-1", [
      workgroupTarget(),
      workgroupTarget({ ownerKey: `w:${OTHER_WG}`, ownerId: OTHER_WG, cadence: "quarterly" }),
      treasuryTarget({ periodMonth: "2026-11" }),
    ]);

    expect(spent).toEqual([
      { ownerKey: WG_KEY, periodMonth: "2026-10", unit: LOVELACE, amount: 10_000_000n },
      { ownerKey: `w:${OTHER_WG}`, periodMonth: "2026-10", unit: LOVELACE, amount: 12_000_000n },
      { ownerKey: T_KEY, periodMonth: "2026-11", unit: LOVELACE, amount: 4_000_000n },
    ]);
    expect(queryOf("payouts")!.filters).toEqual(expect.arrayContaining([
      ["in", "tasks.workgroup_id", [WG, OTHER_WG]],
      ["or", "budget_month.is.null,and(budget_month.gte.2026-10-01,budget_month.lt.2027-01-01)", { referencedTable: "tasks" }],
    ]));
    expect(queryOf("payments")!.filters).toEqual(expect.arrayContaining([["gte", "budget_month", "2026-10-01"], ["lt", "budget_month", "2027-01-01"]]));
    expect(mocks.legacy).toHaveBeenCalledExactlyOnceWith("c-1", { from: "2026-10-01", to: "2027-01-01" });
  });

  it("reads every page of a long list", async () => {
    const page = Array.from({ length: 500 }, (_, i) => payoutRow({ transaction_id: `tx-${i}`, amount: "1" }));
    answers.payouts = page;
    expect(await loadSpentForTargets("c-1", [workgroupTarget()])).toEqual([
      { ownerKey: WG_KEY, periodMonth: "2026-10", unit: LOVELACE, amount: 500n },
    ]);
    // Each page is a fresh query with the same filters.
    const pages = queries.filter((q) => q.table === "payouts");
    expect(pages.flatMap((q) => q.ranges)).toEqual([[0, 499], [500, 999]]);
    expect(pages[1]!.filters).toEqual(pages[0]!.filters);
  });
});
