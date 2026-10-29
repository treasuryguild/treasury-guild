import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletTokenWire } from "@/lib/api/types";
import { overBudgetFields } from "./budget";
import { canBuildPayout } from "./canBuild";
import { deriveMatching } from "./matching";
import { deriveSelection, hasBounty, isPayable, isReady, routedElsewhere, taskAmounts, taskRoute, tokenLabel } from "./selection";
import { addPreviewAmount, describeTotals, summarizeSelection, totalInBaseUnits } from "./summary";
import type { PayableTask } from "./types";
import { buildPaydayView, isFiltered, matchesQuery, NO_FILTER, readyCountByTreasury, taskStatus } from "./view";

const HOSKY = `${"a".repeat(56)}484f534b59`;
const HOSKY2 = `${"b".repeat(56)}484f534b59`;

let nextId = 0;
function assignee(wallet: string | null, position = 0): PayableTask["task_assignees"][number] {
  return {
    id: `a${nextId++}`,
    source: wallet ? "manual" : "github",
    gh_login: wallet ? null : "carol",
    gh_user_id: null,
    wallet_address: wallet,
    position,
    contributors: null,
  };
}

function task(over: Partial<PayableTask>): PayableTask {
  return {
    id: "t",
    number: 1,
    title: "Task",
    body: null,
    source: "native",
    column_id: null,
    task_assignees: [assignee("addr1alice")],
    bounty_lovelace: null,
    amounts: { ADA: "10" },
    pay_state: "payable",
    archived_at: null,
    budget_month: null,
    paid_tx_hash: null,
    chain_number: null,
    gh_url: null, gh_status: null, gh_labels: null, gh_node_id: null, gh_repo_id: null, gh_issue_number: null,
    workgroup_id: "wg1",
    workgroup: { name: "Core", treasury_id: null },
    ...over,
  };
}

function token(unit: string, ticker: string | null, quantity = "1000"): WalletTokenWire {
  return { unit, quantity, ticker, name: ticker, decimals: 0, source: ticker ? "registry" : "none" };
}

describe("selection", () => {
  it("renders legacy lovelace bounties exactly as ADA", () => {
    expect(taskAmounts(task({ amounts: null, bounty_lovelace: 1_500_000 }))).toEqual({ ADA: "1.5" });
    expect(taskAmounts(task({ amounts: { HOSKY: "3" } }))).toEqual({ HOSKY: "3" });
    expect(taskAmounts(task({ amounts: null }))).toEqual({});
  });

  it("selects ready tasks: every assignee with a wallet, and an amount", () => {
    const tasks = [
      task({ id: "a" }),
      task({ id: "b", task_assignees: [] }),
      task({ id: "c", amounts: null }),
      task({ id: "d", task_assignees: [assignee("addr1alice"), assignee(null, 1)] }),
      task({ id: "e", task_assignees: [assignee("addr1alice"), assignee("addr1bob", 1)] }),
    ];
    expect([...deriveSelection(tasks, "", new Set())]).toEqual(["a", "e"]);
    expect([...deriveSelection(tasks, "", new Set(["a"]))]).toEqual(["e"]);
  });

  it("drops tasks routed to another treasury", () => {
    const routed = task({ id: "r", workgroup: { name: "Ops", treasury_id: "t2" } });
    expect(routedElsewhere(routed, "t1")).toBe("t2");
    expect(routedElsewhere(routed, "t2")).toBeNull();
    expect(routedElsewhere(routed, "")).toBeNull();
    expect([...deriveSelection([routed, task({ id: "x" })], "t1", new Set())]).toEqual(["x"]);
  });

  it("routes by the task's own budget period when the dated routing is known", () => {
    const routing = {
      assignments: new Map([["wg1", [
        { treasury_id: "t1", starts_on: "1000-01-01" },
        { treasury_id: "t2", starts_on: "2026-10-01" },
      ]]]),
      setups: new Map(),
    };
    const old = task({ id: "old", budget_month: "2026-09-01", workgroup: { name: "Core", treasury_id: "t2" } });
    const next = task({ id: "next", budget_month: "2026-10-01", workgroup: { name: "Core", treasury_id: "t1" } });
    expect(routedElsewhere(old, "t2", routing)).toBe("t1");
    expect(routedElsewhere(old, "t1", routing)).toBeNull();
    expect(routedElsewhere(next, "t1", routing)).toBe("t2");
    // A workgroup without any assignment falls back to its current wallet.
    const free = task({ id: "free", workgroup_id: "wg9", workgroup: { name: "Ops", treasury_id: "t3" } });
    expect(routedElsewhere(free, "t1", routing)).toBe("t3");
    expect([...deriveSelection([old, next], "t2", new Set(), routing)]).toEqual(["next"]);
  });
});

describe("summary", () => {
  it("totals per field and counts contributors", () => {
    const s = summarizeSelection(
      [
        task({ id: "a", amounts: { ADA: "10", HOSKY: "5" } }),
        task({ id: "b", task_assignees: [assignee("addr1bob")], amounts: { ADA: "2.5" }, workgroup_id: "wg2" }),
        task({ id: "c" }),
      ],
      new Set(["a", "b"]),
    );
    expect(s.count).toBe(2);
    expect(s.payments).toBe(2);
    expect([...s.wallets]).toEqual(["addr1alice", "addr1bob"]);
    expect(s.totals.get("ADA")).toEqual({ quantity: 125n, decimals: 1 });
    expect(s.totals.get("HOSKY")).toEqual({ quantity: 5n, decimals: 0 });
    expect(s.hasTokens).toBe(true);
    expect([...s.selectedWorkgroupIds]).toEqual(["wg1", "wg2"]);
    expect(describeTotals(s.totals)).toBe("12.5 ₳ + 5 HOSKY");
  });

  it("pays every assignee the full amounts and counts a shared wallet once", () => {
    const s = summarizeSelection(
      [
        task({
          id: "a",
          amounts: { ADA: "10" },
          task_assignees: [assignee("addr1alice"), assignee("addr1bob", 1), assignee("addr1carol", 2)],
        }),
        task({ id: "b", task_assignees: [assignee("addr1bob")], amounts: { ADA: "1" } }),
        // Not payable until every assignee is linked: excluded from totals.
        task({ id: "c", task_assignees: [assignee("addr1alice"), assignee(null, 1)], amounts: { ADA: "100" } }),
      ],
      new Set(["a", "b", "c"]),
    );
    expect(s.count).toBe(3);
    expect(s.payments).toBe(4);
    expect([...s.wallets]).toEqual(["addr1alice", "addr1bob", "addr1carol"]);
    expect(s.totals.get("ADA")).toEqual({ quantity: 31n, decimals: 0 });
  });
});

describe("matching", () => {
  it("auto-matches a unique ticker and asks for ambiguous/unmatched ones", () => {
    const m = deriveMatching(["ADA", "HOSKY", "SNEK"], [], [token(HOSKY, "HOSKY")], {});
    expect(m.effective).toEqual([{ fieldName: "HOSKY", unit: HOSKY, decimals: 0 }]);
    expect([...m.needsPick.keys()]).toEqual(["SNEK"]);
    expect(m.unresolved).toEqual(["SNEK"]);

    const amb = deriveMatching(["HOSKY"], [], [token(HOSKY, "HOSKY"), token(HOSKY2, "HOSKY")], {});
    expect(amb.needsPick.get("HOSKY")?.map((t) => t.unit)).toEqual([HOSKY, HOSKY2]);
    expect(amb.unresolved).toEqual(["HOSKY"]);
  });

  it("manual connections override and resolve; stale mappings only warn", () => {
    const registry = [{ fieldName: "HOSKY", unit: HOSKY2, decimals: 2 }];
    const withoutToken = deriveMatching(["HOSKY"], registry, [token(HOSKY, "HOSKY")], {});
    expect(withoutToken.stale).toEqual(["HOSKY"]);
    expect(withoutToken.unresolved).toEqual([]);

    const connected = deriveMatching(["HOSKY"], registry, [token(HOSKY, "HOSKY")], { HOSKY: HOSKY });
    expect(connected.effective).toEqual([{ fieldName: "HOSKY", unit: HOSKY, decimals: 0 }]);
    expect(connected.unresolved).toEqual([]);
  });
});

describe("budget + permissions", () => {
  it("flags fields the wallet cannot cover", () => {
    const wallet = { lovelace: "5000000", utxoCount: 1, tokens: [token(HOSKY, "HOSKY", "3")] };
    const effective = [{ fieldName: "HOSKY", unit: HOSKY, decimals: 0 }];
    const whole = (quantity: bigint) => ({ quantity, decimals: 0 });
    const totals = new Map([["ADA", whole(10n)], ["HOSKY", whole(5n)], ["SNEK", whole(1n)]]);
    expect(overBudgetFields(totals, wallet, effective)).toEqual(["ADA", "HOSKY"]);
    expect(overBudgetFields(totals, null, effective)).toEqual([]);
  });

  it("compares exactly, where float sums drift", () => {
    // 0.1 + 0.2 as floats is 0.30000000000000004 and would flag a wallet holding exactly 0.3 ADA.
    let total = addPreviewAmount(undefined, "0.1", 1);
    total = addPreviewAmount(total, "0.2", 1);
    expect(total).toEqual({ quantity: 3n, decimals: 1 });
    const wallet = { lovelace: "300000", utxoCount: 1, tokens: [] };
    expect(overBudgetFields(new Map([["ADA", total]]), wallet, [])).toEqual([]);
    expect(overBudgetFields(new Map([["ADA", addPreviewAmount(total, "0.000001", 1)]]), wallet, [])).toEqual(["ADA"]);
  });

  it("keeps the widest precision and rounds up to the asset's", () => {
    const total = addPreviewAmount(addPreviewAmount(undefined, "1.5", 2), "0.25", 1);
    expect(total).toEqual({ quantity: 325n, decimals: 2 });
    expect(totalInBaseUnits(total, 6)).toBe(3_250_000n);
    expect(totalInBaseUnits(total, 1)).toBe(33n);
    expect(addPreviewAmount(total, "abc", 1)).toEqual(total);
  });

  it("mirrors the server's build rule", () => {
    const base = {
      treasuryId: "t1",
      signerTreasuryIds: new Set<string>(),
      ledWorkgroupIds: new Set(["wg1"]),
      selectedWorkgroupIds: new Set(["wg1"]),
    };
    expect(canBuildPayout(base)).toBe(true);
    expect(canBuildPayout({ ...base, selectedWorkgroupIds: new Set(["wg1", "wg2"]) })).toBe(false);
    expect(canBuildPayout({ ...base, selectedWorkgroupIds: new Set() })).toBe(false);
    expect(canBuildPayout({ ...base, selectedWorkgroupIds: new Set(), signerTreasuryIds: new Set(["t1"]) })).toBe(true);
  });
});

describe("view", () => {
  const core = (over: Partial<PayableTask>) => task({ workgroup_id: "wg1", workgroup: { name: "Core", treasury_id: "t1" }, ...over });
  const art = (over: Partial<PayableTask>) => task({ workgroup_id: "wg2", workgroup: { name: "Art", treasury_id: "t1" }, ...over });
  const ops = (over: Partial<PayableTask>) => task({ workgroup_id: "wg3", workgroup: { name: "Ops", treasury_id: "t2" }, ...over });
  const any = (over: Partial<PayableTask>) => task({ workgroup_id: "wg4", workgroup: { name: "Guild", treasury_id: null }, ...over });
  const tasks = [
    core({ id: "c2", number: 2, title: "Docs" }),
    core({ id: "c1", number: 1, title: "Fix login", task_assignees: [] }),
    art({ id: "a5", number: 5, title: "Logo" }),
    ops({ id: "o3", number: 3, title: "Servers" }),
    any({ id: "g4", number: 4, title: "Call: weekly" }),
  ];
  const view = (treasuryId: string, filter = NO_FILTER, optedOut = new Set<string>()) =>
    buildPaydayView(tasks, { treasuryId, selected: deriveSelection(tasks, treasuryId, optedOut), filter });

  it("scopes to the treasury: routed here or unrouted, the rest set apart", () => {
    const v = view("t1");
    expect(v.groups.map((g) => g.name)).toEqual(["Art", "Core", "Guild"]);
    expect(v.groups[1]!.visible.map((t) => t.number)).toEqual([1, 2]);
    expect([...v.elsewhere.keys()]).toEqual(["t2"]);
    expect(v.elsewhereCount).toBe(1);
    expect(v.counts).toEqual({ all: 4, selected: 3, unticked: 0, attention: 1 });
    expect(v.groups[1]).toMatchObject({ selectedCount: 1, attentionCount: 1 });
    // No treasury chosen: everything is listed, nothing set apart.
    expect(view("").counts.all).toBe(5);
    expect(view("").elsewhereCount).toBe(0);
  });

  it("filters the view without changing the selection", () => {
    const optedOut = new Set(["a5"]);
    const byStatus = view("t1", { ...NO_FILTER, status: "unticked" }, optedOut);
    expect(byStatus.groups.flatMap((g) => g.visible.map((t) => t.id))).toEqual(["a5"]);
    expect(byStatus.counts).toEqual({ all: 4, selected: 2, unticked: 1, attention: 1 });
    expect(byStatus.hiddenSelected).toBe(2);
    const byGroup = view("t1", { ...NO_FILTER, workgroupId: "wg1" });
    expect(byGroup.groups.map((g) => g.name)).toEqual(["Core"]);
    expect(byGroup.hiddenSelected).toBe(2);
    expect(byGroup.elsewhere.size).toBe(0);
    expect(byGroup.elsewhereCount).toBe(1);
    expect(byGroup.workgroups.map((w) => w.name)).toEqual(["Art", "Core", "Guild", "Ops"]);
    expect(view("t1").hiddenSelected).toBe(0);
  });

  it("keeps choices across a reload and selects a task an edit made ready", () => {
    const optedOut = new Set(["c2"]);
    const reloaded = tasks.map((t) => (t.id === "c1" ? { ...t, task_assignees: [assignee("addr1dan")] } : { ...t }));
    expect([...deriveSelection(reloaded, "t1", optedOut)].sort()).toEqual(["a5", "c1", "g4"]);
  });

  it("matches a task number or a piece of the title", () => {
    const t = task({ number: 12, title: "Fix Login" });
    expect(matchesQuery(t, "#12")).toBe(true);
    expect(matchesQuery(t, "12")).toBe(true);
    expect(matchesQuery(t, "1")).toBe(false);
    expect(matchesQuery(t, "login")).toBe(true);
    expect(matchesQuery(t, "  ")).toBe(true);
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ ...NO_FILTER, query: " x " })).toBe(true);
  });

  it("counts ready tasks per treasury, unrouted ones for each", () => {
    expect(readyCountByTreasury(tasks, ["t1", "t2"])).toEqual(new Map([["t1", 3], ["t2", 2]]));
  });
});

describe("task readiness", () => {
  it("hasBounty: any amounts entry, or a legacy lovelace bounty", () => {
    expect(hasBounty(task({}))).toBe(true);
    expect(hasBounty(task({ amounts: { HOSKY: "3" } }))).toBe(true);
    expect(hasBounty(task({ amounts: null, bounty_lovelace: 1_500_000 }))).toBe(true);
    // Empty amounts fall back to the legacy bounty.
    expect(hasBounty(task({ amounts: {}, bounty_lovelace: 1_500_000 }))).toBe(true);
    expect(hasBounty(task({ amounts: null }))).toBe(false);
    expect(hasBounty(task({ amounts: {} }))).toBe(false);
    expect(hasBounty(task({ amounts: null, bounty_lovelace: 0 }))).toBe(false);
  });

  it("isPayable: at least one assignee and every one with a wallet, whatever the bounty", () => {
    expect(isPayable(task({}))).toBe(true);
    expect(isPayable(task({ task_assignees: [assignee("addr1alice"), assignee("addr1bob", 1)] }))).toBe(true);
    expect(isPayable(task({ task_assignees: [] }))).toBe(false);
    expect(isPayable(task({ task_assignees: [assignee(null)] }))).toBe(false);
    expect(isPayable(task({ task_assignees: [assignee("addr1alice"), assignee(null, 1)] }))).toBe(false);
    expect(isPayable(task({ amounts: null }))).toBe(true);
  });

  it("isReady: payable and with a bounty, both", () => {
    expect(isReady(task({}))).toBe(true);
    expect(isReady(task({ amounts: null, bounty_lovelace: 2_000_000 }))).toBe(true);
    expect(isReady(task({ amounts: null }))).toBe(false);
    expect(isReady(task({ task_assignees: [] }))).toBe(false);
    expect(isReady(task({ task_assignees: [assignee("addr1alice"), assignee(null, 1)] }))).toBe(false);
    expect(isReady(task({ task_assignees: [], amounts: null }))).toBe(false);
  });

  it("taskStatus: a task that is not ready needs attention, ticked or not", () => {
    const ready = task({ id: "ready" });
    const noWallet = task({ id: "no-wallet", task_assignees: [assignee(null)] });
    const noBounty = task({ id: "no-bounty", amounts: null });
    expect(taskStatus(ready, new Set(["ready"]))).toBe("selected");
    expect(taskStatus(ready, new Set())).toBe("unticked");
    expect(taskStatus(ready, new Set(["other"]))).toBe("unticked");
    expect(taskStatus(noWallet, new Set())).toBe("attention");
    expect(taskStatus(noBounty, new Set())).toBe("attention");
    // A stale selection never makes an unready task "selected".
    expect(taskStatus(noWallet, new Set(["no-wallet"]))).toBe("attention");
  });

  it("taskStatus agrees with the counts of the Payday view", () => {
    const tasks = [
      task({ id: "a", number: 1 }),
      task({ id: "b", number: 2 }),
      task({ id: "c", number: 3, amounts: null }),
    ];
    const selected = new Set(["a"]);
    const view = buildPaydayView(tasks, { treasuryId: "t1", selected, filter: NO_FILTER });
    const tally = { selected: 0, unticked: 0, attention: 0 };
    for (const t of tasks) tally[taskStatus(t, selected)]++;
    expect(view.counts).toEqual({ all: 3, ...tally });
  });
});

describe("taskRoute", () => {
  afterEach(() => vi.useRealTimers());

  const assignments = [
    { treasury_id: "t1", starts_on: "1000-01-01" },
    { treasury_id: "t2", starts_on: "2026-11-01" },
  ];
  const routing = (setups: { starts_on: string; cadence: "monthly" | "quarterly" }[] = []) => ({
    assignments: new Map([["wg1", assignments]]),
    setups: new Map([["wg1", setups]]),
  });

  it("without a routing context is the workgroup's current wallet, or null for any wallet", () => {
    expect(taskRoute(task({ workgroup: { name: "Core", treasury_id: "t9" } }))).toBe("t9");
    expect(taskRoute(task({}))).toBeNull();
  });

  it("falls back to the current wallet for a workgroup the context has no timeline for", () => {
    const other = task({ workgroup_id: "wg9", workgroup: { name: "Ops", treasury_id: "t3" } });
    expect(taskRoute(other, routing())).toBe("t3");
  });

  it("takes the wallet in force for the task's own budget month, ignoring the current wallet", () => {
    const current = { name: "Core", treasury_id: "t-current" };
    expect(taskRoute(task({ budget_month: "2026-10-01", workgroup: current }), routing())).toBe("t1");
    expect(taskRoute(task({ budget_month: "2026-11-01", workgroup: current }), routing())).toBe("t2");
    expect(taskRoute(task({ budget_month: "2027-03-01", workgroup: current }), routing())).toBe("t2");
  });

  it("uses the current month for a task with no budget month yet", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T23:00:00Z"));
    expect(taskRoute(task({ budget_month: null }), routing())).toBe("t1");
    vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    expect(taskRoute(task({ budget_month: null }), routing())).toBe("t2");
  });

  it("reads a quarterly workgroup's task through its quarter: a mid-quarter wallet change waits for the next one", () => {
    const quarterly = routing([{ starts_on: "2026-01-01", cadence: "quarterly" }]);
    // November belongs to the quarter starting in October, before the change on 1 November.
    expect(taskRoute(task({ budget_month: "2026-11-01" }), quarterly)).toBe("t1");
    expect(taskRoute(task({ budget_month: "2026-12-01" }), quarterly)).toBe("t1");
    expect(taskRoute(task({ budget_month: "2027-01-01" }), quarterly)).toBe("t2");
    // The same task in a monthly workgroup follows the change at once.
    expect(taskRoute(task({ budget_month: "2026-11-01" }), routing([{ starts_on: "2026-01-01", cadence: "monthly" }]))).toBe("t2");
  });

  it("is null when the period's assignment is any wallet, or the timeline has not started", () => {
    const open = {
      assignments: new Map([["wg1", [
        { treasury_id: "t1", starts_on: "2026-06-01" },
        { treasury_id: null, starts_on: "2026-09-01" },
      ]]]),
      setups: new Map(),
    };
    const current = { name: "Core", treasury_id: "t1" };
    expect(taskRoute(task({ budget_month: "2026-08-01", workgroup: current }), open)).toBe("t1");
    expect(taskRoute(task({ budget_month: "2026-09-01", workgroup: current }), open)).toBeNull();
    expect(taskRoute(task({ budget_month: "2026-05-01", workgroup: current }), open)).toBeNull();
    // A known but empty timeline is "any wallet", not the cached current one.
    expect(taskRoute(task({ budget_month: "2026-09-01", workgroup: current }), { assignments: new Map([["wg1", []]]), setups: new Map() })).toBeNull();
  });

  it("is what routedElsewhere compares the paying treasury against", () => {
    const t = task({ budget_month: "2026-11-01" });
    expect(routedElsewhere(t, "t1", routing())).toBe(taskRoute(t, routing()));
    expect(routedElsewhere(t, "t2", routing())).toBeNull();
  });
});

describe("tokenLabel", () => {
  it("prefers the ticker, then the name, then a short form of the unit", () => {
    expect(tokenLabel({ ticker: "HOSKY", name: "Hosky Token", unit: HOSKY })).toBe("HOSKY");
    expect(tokenLabel({ ticker: null, name: "Hosky Token", unit: HOSKY })).toBe("Hosky Token");
    expect(tokenLabel({ ticker: null, name: null, unit: HOSKY })).toBe("aaaaaaaaaaaa…");
    expect(tokenLabel(token(HOSKY2, null))).toBe("bbbbbbbbbbbb…");
    expect(tokenLabel(token(HOSKY, "HOSKY"))).toBe("HOSKY");
  });
});
