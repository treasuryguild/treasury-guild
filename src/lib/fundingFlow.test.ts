import { describe, expect, it } from "vitest";
import type { DashboardSeries } from "@/lib/api/types";
import { ALL_WORKGROUPS, allTimeWindow, dashboardWindow } from "./dashboardSeries";
import {
  aggregateFlows,
  fitFlowLabel,
  FLOW_LABEL_CHAR_PX,
  flowColumns,
  flowMinWidth,
  flowUnits,
  fundingFlowGraph,
  inflowAmounts,
  inflowKind,
  type FlowIncomingRow,
  type FlowMonth,
} from "./fundingFlow";

const ADA = { ticker: "ADA", decimals: 6 };
const MAIN = "t-main";
const DEV = "t-dev";
const treasuries = [{ id: MAIN, name: "Main" }, { id: DEV, name: "Dev wallet" }];
const names = new Map([["wg-a", "Alpha"], ["wg-b", "Beta"]]);

function row(overrides: Partial<FlowIncomingRow>): FlowIncomingRow {
  return {
    treasuryId: MAIN, fromTreasuryId: null, incomingType: "contribution",
    amountLovelace: "1000000", assets: null, blockTime: "2026-09-10T12:00:00Z", ...overrides,
  };
}

function series(months: DashboardSeries["months"]): DashboardSeries {
  return { months, bucket: "month", period: { contributors: 0, tasks: 0, byOwner: [] }, treasuries };
}

/** Cells keyed by workgroup, or by a treasury (`ownerType: "treasury"`) for its direct payments. */
function spendingMonth(
  month: string,
  cells: { workgroupId: string; treasuryId: string; amount: string; unit?: string; ownerType?: "workgroup" | "treasury" }[],
): DashboardSeries["months"][number] {
  const byOwner = new Map<string, { ownerType: "workgroup" | "treasury"; spending: { treasuryId: string; unit: string; amount: string }[] }>();
  for (const cell of cells) {
    const owner = byOwner.get(cell.workgroupId) ?? { ownerType: cell.ownerType ?? "workgroup", spending: [] };
    owner.spending.push({ treasuryId: cell.treasuryId, unit: cell.unit ?? "lovelace", amount: cell.amount });
    byOwner.set(cell.workgroupId, owner);
  }
  return {
    month, contributors: 0, tasks: 0,
    byOwner: [...byOwner].map(([ownerId, owner]) => ({ ownerType: owner.ownerType, ownerId, contributors: 0, tasks: 0, spending: owner.spending })),
  };
}

describe("inflowKind", () => {
  it("counts classified and unclassified inflows as income, never refunds or unlinked transfers", () => {
    expect(inflowKind("contribution")).toBe("contribution");
    expect(inflowKind("revenue")).toBe("revenue");
    expect(inflowKind("other")).toBe("other");
    expect(inflowKind("unclassified")).toBe("unclassified");
    expect(inflowKind("refund")).toBeNull();
    expect(inflowKind("transfer")).toBeNull();
  });
});

describe("aggregateFlows", () => {
  const window = dashboardWindow("2026-09", "month");

  it("sums income per treasury, token and kind by block-time month", () => {
    const flows = aggregateFlows([
      row({ amountLovelace: "1000000" }),
      row({ amountLovelace: "2000000", blockTime: "2026-09-20T00:00:00Z" }),
      row({ amountLovelace: "5", incomingType: "revenue", assets: { tokenA: "40" } }),
      row({ amountLovelace: "700000", blockTime: "2026-08-02T00:00:00Z", treasuryId: DEV }),
    ], window);
    const september = flows.find((month) => month.month === "2026-09")!;
    expect(september.inflows).toEqual([
      { treasuryId: MAIN, unit: "lovelace", kind: "contribution", amount: "3000000" },
      { treasuryId: MAIN, unit: "lovelace", kind: "revenue", amount: "5" },
      { treasuryId: MAIN, unit: "tokenA", kind: "revenue", amount: "40" },
    ]);
    expect(flows.find((month) => month.month === "2026-08")!.inflows).toEqual([
      { treasuryId: DEV, unit: "lovelace", kind: "contribution", amount: "700000" },
    ]);
    expect(flows).toHaveLength(12);
  });

  it("turns linked inflows into transfers whatever their type and drops refunds", () => {
    const flows = aggregateFlows([
      row({ treasuryId: DEV, fromTreasuryId: MAIN, incomingType: "transfer", amountLovelace: "4000000" }),
      row({ treasuryId: DEV, fromTreasuryId: MAIN, incomingType: "contribution", amountLovelace: "1000000" }),
      row({ incomingType: "refund", amountLovelace: "999" }),
      row({ incomingType: "transfer", amountLovelace: "888" }),
      row({ blockTime: null }),
    ], window);
    const september = flows.find((month) => month.month === "2026-09")!;
    expect(september.transfers).toEqual([{ fromTreasuryId: MAIN, toTreasuryId: DEV, unit: "lovelace", amount: "5000000" }]);
    expect(september.inflows).toEqual([]);
  });

  it("sums a long all-time window by quarter, under the quarter's first month", () => {
    const flows = aggregateFlows([
      row({ amountLovelace: "1000000", blockTime: "2024-04-02T00:00:00Z" }),
      row({ amountLovelace: "2000000", blockTime: "2024-06-30T00:00:00Z" }),
      row({ amountLovelace: "4000000" }),
    ], allTimeWindow("2024-04", "2026-09"));
    expect(flows.map((month) => month.month)).toEqual([
      "2024-04", "2024-07", "2024-10", "2025-01", "2025-04", "2025-07", "2025-10", "2026-01", "2026-04", "2026-07",
    ]);
    expect(flows[0]!.inflows).toEqual([{ treasuryId: MAIN, unit: "lovelace", kind: "contribution", amount: "3000000" }]);
    expect(flows[9]!.inflows).toEqual([{ treasuryId: MAIN, unit: "lovelace", kind: "contribution", amount: "4000000" }]);
  });

  it("ignores rows outside the window and lists every token seen", () => {
    const flows = aggregateFlows([
      row({ blockTime: "2024-01-01T00:00:00Z", assets: { old: "1" } }),
      row({ assets: { tokenB: "3" } }),
    ], window);
    expect(flowUnits(flows).sort()).toEqual(["lovelace", "tokenB"]);
  });
});

describe("flow label layout", () => {
  const node = (key: string) => ({ key, name: key, kind: "treasury" as const, inflow: "", outflow: "" });
  const link = (source: number, target: number) => ({ source, target, value: 1, kind: "transfer" as const, amount: "1", label: "1" });

  it("counts the columns of the longest chain, whatever the node order", () => {
    expect(flowColumns({ nodes: [], links: [] })).toBe(1);
    expect(flowColumns({ nodes: [node("a"), node("b"), node("c")], links: [link(0, 1), link(1, 2), link(0, 2)] })).toBe(3);
    // A transfer from a later treasury to an earlier one: 0 → 2 → 1 → 3.
    expect(flowColumns({ nodes: ["a", "b", "c", "d"].map(node), links: [link(0, 2), link(1, 3), link(2, 1)] })).toBe(4);
  });

  it("keeps a minimum width only for a chain of four or more columns", () => {
    expect(flowMinWidth(3)).toBeNull();
    expect(flowMinWidth(4)).toBe(600);
    expect(flowMinWidth(5)).toBe(750);
  });

  it("cuts a label to its room with an ellipsis, or drops it", () => {
    const name = "[LIVE] Signius Payout Runs";
    const room = (chars: number) => chars * FLOW_LABEL_CHAR_PX + 1;
    expect(fitFlowLabel(name, room(name.length))).toBe(name);
    expect(fitFlowLabel(name, room(9))).toBe("[LIVE] S…");
    // No space left hanging before the ellipsis.
    expect(fitFlowLabel(name, room(8))).toBe("[LIVE]…");
    expect(fitFlowLabel(name, room(2))).toBe("");
    expect(fitFlowLabel(name, 0)).toBe("");
    expect(fitFlowLabel("ADA", room(3))).toBe("ADA");
  });
});

describe("fundingFlowGraph", () => {
  const flows: FlowMonth[] = [
    {
      month: "2026-09",
      inflows: [
        { treasuryId: MAIN, unit: "lovelace", kind: "contribution", amount: "10000000" },
        { treasuryId: DEV, unit: "lovelace", kind: "revenue", amount: "1500000" },
        { treasuryId: MAIN, unit: "tokenA", kind: "contribution", amount: "7" },
      ],
      transfers: [{ fromTreasuryId: MAIN, toTreasuryId: DEV, unit: "lovelace", amount: "4000000" }],
    },
    {
      month: "2026-08",
      inflows: [{ treasuryId: MAIN, unit: "lovelace", kind: "contribution", amount: "99000000" }],
      transfers: [],
    },
  ];
  const paid = series([
    spendingMonth("2026-09", [
      { workgroupId: "wg-a", treasuryId: MAIN, amount: "2000000" },
      { workgroupId: "wg-b", treasuryId: DEV, amount: "3000000" },
      { workgroupId: "wg-b", treasuryId: MAIN, amount: "3", unit: "tokenA" },
    ]),
    spendingMonth("2026-08", [{ workgroupId: "wg-a", treasuryId: MAIN, amount: "50000000" }]),
  ]);
  const base = { flows, series: paid, months: ["2026-09"], unit: "lovelace", info: ADA, workgroupId: ALL_WORKGROUPS, treasuries, names };

  it("chains sources, treasuries and workgroups for the selected months and token", () => {
    const graph = fundingFlowGraph(base);
    expect(graph.nodes.map((node) => node.name)).toEqual(["Contributions", "Revenue", "Main", "Dev wallet", "Alpha", "Beta"]);
    const named = graph.links.map((link) => [graph.nodes[link.source]!.name, graph.nodes[link.target]!.name, link.kind, link.label]);
    expect(named).toEqual([
      ["Contributions", "Main", "income", "10 ADA"],
      ["Revenue", "Dev wallet", "income", "1.5 ADA"],
      ["Main", "Dev wallet", "transfer", "4 ADA"],
      ["Main", "Alpha", "payout", "2 ADA"],
      ["Dev wallet", "Beta", "payout", "3 ADA"],
    ]);
    expect(graph.links.find((link) => link.kind === "transfer")!.value).toBe(4);
    expect(graph.nodes.find((node) => node.name === "Main")).toMatchObject({ inflow: "10 ADA", outflow: "6 ADA" });
    expect(graph.table).toHaveLength(5);
    expect(graph.notes).toEqual([]);
  });

  it("narrows to one workgroup and what fed its wallets", () => {
    const graph = fundingFlowGraph({ ...base, workgroupId: "wg-b" });
    const named = graph.links.map((link) => `${graph.nodes[link.source]!.name} → ${graph.nodes[link.target]!.name}`);
    expect(named).toEqual(["Contributions → Main", "Revenue → Dev wallet", "Main → Dev wallet", "Dev wallet → Beta"]);
  });

  it("draws another token on its own", () => {
    const graph = fundingFlowGraph({ ...base, unit: "tokenA", info: { ticker: "TOKA", decimals: 0 } });
    expect(graph.links.map((link) => link.label)).toEqual(["7 TOKA", "3 TOKA"]);
  });

  it("nets two-way transfers and explains it, keeping the raw table", () => {
    const twoWay: FlowMonth[] = [{
      month: "2026-09", inflows: [],
      transfers: [
        { fromTreasuryId: MAIN, toTreasuryId: DEV, unit: "lovelace", amount: "5000000" },
        { fromTreasuryId: DEV, toTreasuryId: MAIN, unit: "lovelace", amount: "2000000" },
      ],
    }];
    const graph = fundingFlowGraph({ ...base, flows: twoWay, series: series([]) });
    expect(graph.links).toHaveLength(1);
    expect(graph.links[0]!.label).toBe("3 ADA");
    expect(graph.nodes[graph.links[0]!.source]!.name).toBe("Main");
    expect(graph.table).toHaveLength(2);
    expect(graph.notes[0]).toContain("drawn net");
  });

  it("leaves a three-way loop's smallest transfer out of the diagram", () => {
    const three = [...treasuries, { id: "t-ops", name: "Ops" }];
    const loop: FlowMonth[] = [{
      month: "2026-09", inflows: [],
      transfers: [
        { fromTreasuryId: MAIN, toTreasuryId: DEV, unit: "lovelace", amount: "5000000" },
        { fromTreasuryId: DEV, toTreasuryId: "t-ops", unit: "lovelace", amount: "4000000" },
        { fromTreasuryId: "t-ops", toTreasuryId: MAIN, unit: "lovelace", amount: "1000000" },
      ],
    }];
    const graph = fundingFlowGraph({ ...base, flows: loop, series: series([]), treasuries: three });
    expect(graph.links).toHaveLength(2);
    expect(graph.notes[0]).toContain("Ops to Main");
    expect(graph.table).toHaveLength(3);
  });

  it("drops refund-negative payouts and is empty with nothing to draw", () => {
    const negative = series([spendingMonth("2026-09", [{ workgroupId: "wg-a", treasuryId: MAIN, amount: "-500000" }])]);
    const graph = fundingFlowGraph({ ...base, flows: [], series: negative });
    expect(graph.links).toEqual([]);
    expect(graph.nodes).toEqual([]);
  });

  it("names a treasury that no longer exists", () => {
    const graph = fundingFlowGraph({ ...base, treasuries: [treasuries[0]!] });
    expect(graph.nodes.some((node) => node.name === "Treasury")).toBe(true);
  });

  it("draws direct payments from a treasury into one sink, last, and narrows to that treasury", () => {
    const withPayments = series([
      spendingMonth("2026-09", [
        { workgroupId: "wg-a", treasuryId: MAIN, amount: "2000000" },
        { workgroupId: MAIN, treasuryId: MAIN, amount: "1500000", ownerType: "treasury" },
        { workgroupId: DEV, treasuryId: DEV, amount: "500000", ownerType: "treasury" },
      ]),
    ]);
    const graph = fundingFlowGraph({ ...base, series: withPayments });
    expect(graph.nodes.map((node) => [node.name, node.kind])).toEqual([
      ["Contributions", "source"], ["Revenue", "source"], ["Main", "treasury"], ["Dev wallet", "treasury"],
      ["Alpha", "workgroup"], ["Direct payments", "direct"],
    ]);
    const named = graph.links.map((link) => [graph.nodes[link.source]!.name, graph.nodes[link.target]!.name, link.kind, link.label]);
    expect(named).toContainEqual(["Main", "Direct payments", "payout", "1.5 ADA"]);
    expect(named).toContainEqual(["Dev wallet", "Direct payments", "payout", "0.5 ADA"]);
    expect(graph.nodes.find((node) => node.kind === "direct")).toMatchObject({ inflow: "2 ADA", outflow: "0 ADA" });

    // The filter set to a treasury keeps its direct payments and what fed it.
    const narrowed = fundingFlowGraph({ ...base, series: withPayments, workgroupId: DEV });
    expect(narrowed.links.map((link) => `${narrowed.nodes[link.source]!.name} → ${narrowed.nodes[link.target]!.name}`))
      .toEqual(["Contributions → Main", "Revenue → Dev wallet", "Main → Dev wallet", "Dev wallet → Direct payments"]);
  });
});

describe("funding sources in the flow", () => {
  const window = dashboardWindow("2026-09", "month");
  const fundingSources = [{ id: "fs-mother", name: "Mother treasury" }];

  it("draws a tagged inflow from its funding source, the rest by kind, and never a tagged refund", () => {
    const flows = aggregateFlows([
      row({ amountLovelace: "3000000", fundingSourceId: "fs-mother" }),
      row({ amountLovelace: "1000000" }),
      row({ amountLovelace: "9000000", incomingType: "refund", fundingSourceId: "fs-mother" }),
    ], window);
    expect(flows.find((month) => month.month === "2026-09")!.inflows).toEqual([
      { treasuryId: MAIN, unit: "lovelace", kind: "contribution", amount: "1000000" },
      { treasuryId: MAIN, unit: "lovelace", kind: "contribution", fundingSourceId: "fs-mother", amount: "3000000" },
    ]);
    const graph = fundingFlowGraph({
      flows, series: series([]), months: ["2026-09"], unit: "lovelace", info: ADA,
      workgroupId: ALL_WORKGROUPS, treasuries, names, fundingSources,
    });
    expect(graph.nodes.map((node) => [node.name, node.kind])).toEqual([
      ["Mother treasury", "source"], ["Contributions", "source"], ["Main", "treasury"],
    ]);
    expect(graph.table).toEqual([["Contributions", "Main", "1 ADA"], ["Mother treasury", "Main", "3 ADA"]]);
  });
});

describe("inflowAmounts", () => {
  const TOKEN = `${"a".repeat(56)}47565454`;
  const OTHER = `${"b".repeat(56)}00`;

  it("lists ADA first, then each token, as [unit, quantity] strings", () => {
    expect(inflowAmounts({ amountLovelace: "1500000", assets: { [TOKEN]: "25", [OTHER]: "1" } }))
      .toEqual([["lovelace", "1500000"], [TOKEN, "25"], [OTHER, "1"]]);
  });

  it("leaves zero amounts out", () => {
    expect(inflowAmounts({ amountLovelace: "0", assets: { [TOKEN]: "25" } })).toEqual([[TOKEN, "25"]]);
    expect(inflowAmounts({ amountLovelace: "1500000", assets: { [TOKEN]: "0" } })).toEqual([["lovelace", "1500000"]]);
    expect(inflowAmounts({ amountLovelace: "0", assets: { [TOKEN]: "0" } })).toEqual([]);
  });

  it("takes a row with no tokens", () => {
    expect(inflowAmounts({ amountLovelace: "2000000", assets: null })).toEqual([["lovelace", "2000000"]]);
    expect(inflowAmounts({ amountLovelace: "2000000", assets: {} })).toEqual([["lovelace", "2000000"]]);
    expect(inflowAmounts({ amountLovelace: "0", assets: null })).toEqual([]);
  });

  it("leaves negative amounts out and keeps quantities beyond 2^53 exact", () => {
    expect(inflowAmounts({ amountLovelace: "-5", assets: { [TOKEN]: "-1" } })).toEqual([]);
    expect(inflowAmounts({ amountLovelace: "45000000000000000", assets: { [TOKEN]: "9007199254740993" } }))
      .toEqual([["lovelace", "45000000000000000"], [TOKEN, "9007199254740993"]]);
  });
});
