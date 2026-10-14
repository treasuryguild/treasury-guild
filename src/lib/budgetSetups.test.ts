import { describe, expect, it } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import {
  backfillEndsOffQuarter, budgetAmountLabel, budgetAmountsText, budgetInForce, budgetOwnerLabel, budgetPeriodsAt, cadenceAt,
  contextForOwner, earliestSetupMonth, isBackfill, nextSetupAfter, periodAmounts, resolveAllTimeBudgets,
  resolveSetupBudgets, setupAt, setupLabel, taskBudgetPeriod, type BudgetPlanSource, type BudgetSetupContext,
  type BudgetSetupSource,
} from "./budgetSetups";
import { saveBudgetSetupSchema } from "./api/schemas";

const amount = (value: string) => [{ unit: "lovelace", amount: value, asset_label: "ADA", decimals: 6 }];
const context: BudgetSetupContext = {
  ownerType: "workgroup", ownerId: "design", ownerName: "Design", workgroupId: "design", workgroupKind: "native",
  treasuryId: null, revision: 3,
  legacyConflict: false, legacy: [], history: [],
  timeline: [
    { id: "old", starts_on: "2025-01-01", mode: "recurring", cadence: "monthly", amounts: amount("100") },
    { id: "new", starts_on: "2026-10-01", mode: "recurring", cadence: "monthly", amounts: amount("200") },
    { id: "explicit", starts_on: "2027-01-01", mode: "monthly", cadence: "monthly", amounts: [] },
    { id: "quarter", starts_on: "2027-04-01", mode: "quarterly", cadence: "quarterly", amounts: [] },
  ],
  plans: [
    { setup_id: "explicit", starts_on: "2027-01-01", amounts: amount("300") },
    { setup_id: "explicit", starts_on: "2027-04-01", amounts: amount("400") },
    { setup_id: "quarter", starts_on: "2027-04-01", amounts: amount("900") },
  ],
};
describe("dated budget setups", () => {
  it("preserves earlier recurring values and applies the new value from its start", () => {
    expect(resolveSetupBudgets([context], "2026-09", "month")[0]?.amount).toBe("100");
    expect(resolveSetupBudgets([context], "2026-10", "month")[0]?.amount).toBe("200");
    expect(resolveSetupBudgets([context], "2026-12", "month")[0]?.amount).toBe("200");
  });
  it("does not revive recurring defaults for unplanned months", () => {
    expect(resolveSetupBudgets([context], "2027-01", "month")[0]?.amount).toBe("300");
    expect(resolveSetupBudgets([context], "2027-02", "month")).toEqual([]);
    expect(resolveSetupBudgets([context], "2027-02", "recurring")).toEqual([]);
  });
  it("excludes superseded monthly allocations from quarterly periods", () => {
    expect(resolveSetupBudgets([context], "2027-04", "quarter").map((b) => b.amount)).toEqual(["900"]);
    expect(resolveSetupBudgets([context], "2027-07", "quarter")).toEqual([]);
  });
  it("shows a quarterly project's containing quarter in the month view", () => {
    for (const month of ["2027-04", "2027-05"]) {
      const rows = resolveSetupBudgets([context], month, "month");
      expect(rows.map((b) => [b.amount, b.cadence, b.period_start, b.budget_month]))
        .toEqual([["900", "quarterly", "2027-04-01", "2027-04-01"]]);
    }
  });
  it("shows every month of a monthly project in the quarter view", () => {
    const rows = resolveSetupBudgets([context], "2026-11", "quarter");
    expect(rows.map((b) => [b.amount, b.period_start, b.budget_month])).toEqual([
      ["200", "2026-10-01", null], ["200", "2026-11-01", null], ["200", "2026-12-01", null],
    ]);
    expect(new Set(rows.map((b) => b.id)).size).toBe(3);
    // Explicit monthly plans fill only the months that were planned.
    expect(resolveSetupBudgets([context], "2027-02", "quarter").map((b) => [b.amount, b.period_start]))
      .toEqual([["300", "2027-01-01"]]);
  });
  it("lists both cadences across a mid-quarter switch", () => {
    const switching: BudgetSetupContext = { ...context, timeline: [
      { id: "q", starts_on: "2027-01-01", mode: "quarterly", cadence: "quarterly", amounts: [] },
      { id: "m", starts_on: "2027-05-01", mode: "monthly", cadence: "monthly", amounts: [] },
    ] };
    expect(budgetPeriodsAt(switching, "2027-06", "quarter").map((c) => [c.start, c.cadence]))
      .toEqual([["2027-04", "quarterly"], ["2027-05", "monthly"], ["2027-06", "monthly"]]);
    expect(budgetPeriodsAt(switching, "2027-04", "month").map((c) => c.start)).toEqual(["2027-04"]);
    expect(budgetPeriodsAt(switching, "2027-06", "recurring")).toEqual([]);
    expect(budgetPeriodsAt(undefined, "2027-06", "quarter")).toEqual([]);
  });
  it("lists every period from the first setup through the current one for all time", () => {
    const short: BudgetSetupContext = { ...context, timeline: [
      { id: "r", starts_on: "2026-11-01", mode: "recurring", cadence: "monthly", amounts: amount("100") },
      { id: "explicit", starts_on: "2027-01-01", mode: "monthly", cadence: "monthly", amounts: [] },
      { id: "quarter", starts_on: "2027-04-01", mode: "quarterly", cadence: "quarterly", amounts: [] },
    ] };
    const periods = (through: string) =>
      resolveAllTimeBudgets([short], through).map((b) => [b.amount, b.period_start, b.cadence]);
    // A recurring budget counts once per elapsed month; an unplanned month adds nothing.
    expect(periods("2027-03")).toEqual([
      ["100", "2026-11-01", "monthly"], ["100", "2026-12-01", "monthly"], ["300", "2027-01-01", "monthly"],
    ]);
    // The running quarter counts whole and once, however far into it; later plans stay out.
    expect(periods("2027-04")).toHaveLength(4);
    expect(periods("2027-06")).toEqual([...periods("2027-03"), ["900", "2027-04-01", "quarterly"]]);
    expect(new Set(resolveAllTimeBudgets([short], "2027-06").map((b) => b.id)).size).toBe(4);
    expect(resolveAllTimeBudgets([short], "2026-10")).toEqual([]);
    expect(resolveAllTimeBudgets([{ ...context, timeline: [] }], "2027-06")).toEqual([]);
  });
  it("holds conflicting originals for review instead of double counting them", () => {
    expect(resolveSetupBudgets([{ ...context, legacyConflict: true, timeline: [] }], "2026-09", "month")).toEqual([]);
    expect(setupAt(context, "2024-12")).toBeUndefined();
  });
  it("reports the cadence in force for a month", () => {
    expect(cadenceAt(context.timeline, "2026-09")).toBe("monthly");
    expect(cadenceAt(context.timeline, "2027-04")).toBe("quarterly");
    expect(cadenceAt(context.timeline, "2027-09")).toBe("quarterly");
    expect(cadenceAt(context.timeline, "2024-12")).toBeNull();
    expect(cadenceAt([], "2027-04")).toBeNull();
    expect(cadenceAt(context.timeline, "not-a-month")).toBeNull();
    expect(cadenceAt(context.timeline, "2027-13")).toBeNull();
  });
  it("resolves a task's period from the setup in force for its month", () => {
    const setups = context.timeline;
    // Monthly setup: the month is the period.
    expect(taskBudgetPeriod("2026-09-01", setups, "2026-01")).toEqual({ month: "2026-09", code: "2026-09" });
    // Quarterly setup: aligned to the quarter start and written as the quarter,
    // even for a date stored mid-quarter.
    expect(taskBudgetPeriod("2027-04-01", setups, "2026-01")).toEqual({ month: "2027-04", code: "2027-Q2" });
    expect(taskBudgetPeriod("2027-08-01", setups, "2026-01")).toEqual({ month: "2027-07", code: "2027-Q3" });
    // Unset tasks take the default month, read through the same setup.
    expect(taskBudgetPeriod(null, setups, "2026-11")).toEqual({ month: "2026-11", code: "2026-11" });
    expect(taskBudgetPeriod(null, setups, "2027-11")).toEqual({ month: "2027-10", code: "2027-Q4" });
    // A month before the quarterly setup starts is still a month, and a
    // workgroup with no setup is budgeted by month.
    expect(taskBudgetPeriod("2027-03-01", setups, "2027-11")).toEqual({ month: "2027-03", code: "2027-03" });
    expect(taskBudgetPeriod("2027-05-01", [], "2027-11")).toEqual({ month: "2027-05", code: "2027-05" });
  });
  it("rejects mixed token cadences and missing concurrency revisions at the API boundary", () => {
    const input = { workgroupId: "00000000-0000-0000-0000-000000000001", expectedRevision: 0,
      mode: "recurring", startsOn: "2026-10", budgetCadence: "monthly",
      budgets: [{ unit: "lovelace", amount: "100", cadence: "monthly" }] };
    expect(saveBudgetSetupSchema.safeParse(input).success).toBe(true);
    expect(saveBudgetSetupSchema.safeParse({ ...input, expectedRevision: undefined }).success).toBe(false);
    expect(saveBudgetSetupSchema.safeParse({ ...input, budgets: [...input.budgets, { unit: "token", amount: "100", cadence: "quarterly" }] }).success).toBe(false);
    expect(saveBudgetSetupSchema.safeParse({ ...input, mode: "quarterly", budgetCadence: "quarterly", startsOn: "2026-11", budgets: [] }).success).toBe(false);
  });
});

describe("backfill before the first setup", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-09T00:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });
  const late: BudgetSetupContext = { ...context, timeline: [
    { id: "first", starts_on: "2026-09-01", mode: "recurring", cadence: "monthly", amounts: amount("10") },
  ] };

  it("is a backfill only where no setup is in force and nothing awaits review", () => {
    expect(isBackfill(late, "2026-01")).toBe(true);
    expect(isBackfill(late, "2026-09")).toBe(false);
    expect(isBackfill(undefined, "2026-01")).toBe(true);
    expect(isBackfill({ ...late, legacyConflict: true }, "2026-01")).toBe(false);
    expect(nextSetupAfter(late, "2026-01")?.id).toBe("first");
    expect(nextSetupAfter(late, "2026-09")).toBeUndefined();
  });

  it("lets a backfill start in the past, aligned to its quarter", () => {
    expect(earliestSetupMonth(late, "2026-01", "monthly")).toBe("2026-01");
    expect(earliestSetupMonth(late, "2026-02", "quarterly")).toBe("2026-01");
    // With a setup in force the start is still clamped to the current month.
    expect(earliestSetupMonth(late, "2026-09", "monthly")).toBe("2026-09");
    expect(earliestSetupMonth(context, "2026-01", "monthly")).toBe("2026-09");
  });

  it("refuses a quarterly backfill that would end mid-quarter", () => {
    expect(backfillEndsOffQuarter(late, "2026-01", "quarterly")).toBe(true);
    expect(backfillEndsOffQuarter(late, "2026-01", "monthly")).toBe(false);
    const quarterly: BudgetSetupContext = { ...late, timeline: [
      { id: "q", starts_on: "2026-04-01", mode: "quarterly", cadence: "quarterly", amounts: [] },
    ] };
    expect(backfillEndsOffQuarter(quarterly, "2026-01", "quarterly")).toBe(false);
    expect(backfillEndsOffQuarter(quarterly, "2026-01", "monthly")).toBe(false);
  });
});

describe("budget amount text", () => {
  it("labels a stored amount exactly, with its asset label or else its unit", () => {
    expect(budgetAmountLabel({ unit: "lovelace", amount: "1500000000", asset_label: "ADA", decimals: 6 })).toBe("1,500 ADA");
    expect(budgetAmountLabel({ unit: "lovelace", amount: "1500000", asset_label: "ADA", decimals: 6 })).toBe("1.5 ADA");
    expect(budgetAmountLabel({ unit: "abc123", amount: "42", asset_label: null, decimals: 0 })).toBe("42 abc123");
    // Base units beyond 2^53 keep every digit.
    expect(budgetAmountLabel({ unit: "u", amount: "9007199254740993000001", asset_label: "GVTT", decimals: 6 }))
      .toBe("9,007,199,254,740,993.000001 GVTT");
  });

  it("joins amounts for a sentence and falls back to the empty text", () => {
    const amounts = [
      { unit: "lovelace", amount: "100000000", asset_label: "ADA", decimals: 6 },
      { unit: "token", amount: "2500", asset_label: "GVTT", decimals: 2 },
    ];
    expect(budgetAmountsText(amounts, "no budget")).toBe("100 ADA, 25 GVTT");
    expect(budgetAmountsText(amounts.slice(0, 1), "no budget")).toBe("100 ADA");
    expect(budgetAmountsText([], "no budget")).toBe("no budget");
    // A zero amount is still an amount, not "none".
    expect(budgetAmountsText([{ unit: "lovelace", amount: "0", asset_label: "ADA", decimals: 6 }], "no budget")).toBe("0 ADA");
  });
});

describe("budget owners", () => {
  it("prefixes a treasury's name and leaves a workgroup's alone", () => {
    expect(budgetOwnerLabel("treasury", "Main")).toBe("Treasury: Main");
    expect(budgetOwnerLabel("workgroup", "Design")).toBe("Design");
  });

  it("finds a context by its owner id, whichever type owns it", () => {
    const treasury: BudgetSetupContext = {
      ...context, ownerType: "treasury", ownerId: "main", ownerName: "Main", workgroupId: null, workgroupKind: null, treasuryId: "main",
    };
    expect(contextForOwner([context, treasury], "design")).toBe(context);
    expect(contextForOwner([context, treasury], "main")).toBe(treasury);
    expect(contextForOwner([context, treasury], "missing")).toBeUndefined();
    expect(contextForOwner([], "design")).toBeUndefined();
    // The owner id is the key, not the workgroup or treasury columns beside it.
    const renamed = { ...context, ownerId: "other" };
    expect(contextForOwner([renamed], "design")).toBeUndefined();
  });
});

describe("setupLabel", () => {
  it("names a recurring setup by its cadence and a planned one by its mode", () => {
    expect(setupLabel({ mode: "recurring", cadence: "monthly" })).toBe("Recurring monthly");
    expect(setupLabel({ mode: "recurring", cadence: "quarterly" })).toBe("Recurring quarterly");
    expect(setupLabel({ mode: "monthly", cadence: "monthly" })).toBe("Monthly plan");
    expect(setupLabel({ mode: "quarterly", cadence: "quarterly" })).toBe("Quarterly plan");
    for (const setup of context.timeline) expect(setupLabel(setup)).not.toBe("");
  });
});

describe("periodAmounts", () => {
  const setup = (id: string) => context.timeline.find((s) => s.id === id)!;

  it("gives a recurring setup's own amounts for any period", () => {
    expect(periodAmounts(context, { start: "2026-09", cadence: "monthly", setup: setup("old") })).toEqual(amount("100"));
    expect(periodAmounts(context, { start: "2026-11", cadence: "monthly", setup: setup("new") })).toEqual(amount("200"));
    // A recurring setup never reads the plans, even one stored under its id.
    const planned: BudgetSetupContext = { ...context, plans: [{ setup_id: "old", starts_on: "2026-09-01", amounts: amount("999") }] };
    expect(periodAmounts(planned, { start: "2026-09", cadence: "monthly", setup: setup("old") })).toEqual(amount("100"));
  });

  it("gives a planned setup the plan of that period only, and nothing for an unplanned one", () => {
    expect(periodAmounts(context, { start: "2027-01", cadence: "monthly", setup: setup("explicit") })).toEqual(amount("300"));
    expect(periodAmounts(context, { start: "2027-02", cadence: "monthly", setup: setup("explicit") })).toEqual([]);
    expect(periodAmounts({ ...context, plans: [] }, { start: "2027-01", cadence: "monthly", setup: setup("explicit") })).toEqual([]);
  });

  it("keeps two setups' plans for the same start apart", () => {
    expect(periodAmounts(context, { start: "2027-04", cadence: "monthly", setup: setup("explicit") })).toEqual(amount("400"));
    expect(periodAmounts(context, { start: "2027-04", cadence: "quarterly", setup: setup("quarter") })).toEqual(amount("900"));
  });

  it("agrees with the cells budgetPeriodsAt yields", () => {
    const amounts = (month: string, view: "month" | "quarter" | "recurring") =>
      budgetPeriodsAt(context, month, view).map((cell) => periodAmounts(context, cell).map((a) => a.amount));
    expect(amounts("2026-12", "month")).toEqual([["200"]]);
    expect(amounts("2027-05", "month")).toEqual([["900"]]);
    expect(amounts("2027-01", "quarter")).toEqual([["300"], [], []]);
  });
});

describe("budgetInForce", () => {
  const key = "w:design";
  const setups: BudgetSetupSource[] = context.timeline.map((s, i) => ({
    ...s, owner_key: key, proposal_id: i === 1 ? "p-new" : null,
  }));
  const plans: BudgetPlanSource[] = [
    { setup_id: "explicit", starts_on: "2027-01-01", amounts: amount("300"), proposal_id: "p-jan" },
    { setup_id: "explicit", starts_on: "2027-04-01", amounts: amount("400"), proposal_id: null },
    { setup_id: "quarter", starts_on: "2027-04-01", amounts: amount("900"), proposal_id: null },
  ];

  it("agrees with periodAmounts on the amounts, and names the proposal that set them", () => {
    expect(budgetInForce(setups, plans, "2026-09")).toEqual({
      setupId: "old", periodMonth: "2026-09", cadence: "monthly", amounts: amount("100"), proposalId: null,
    });
    expect(budgetInForce(setups, plans, "2026-11")).toMatchObject({ setupId: "new", amounts: amount("200"), proposalId: "p-new" });
    // A plan row's proposal wins over the setup's; a plan saved directly under a voted setup is direct.
    expect(budgetInForce(setups, plans, "2027-01")).toMatchObject({ setupId: "explicit", amounts: amount("300"), proposalId: "p-jan" });
    expect(budgetInForce(setups, plans, "2027-05")).toEqual({
      setupId: "quarter", periodMonth: "2027-04", cadence: "quarterly", amounts: amount("900"), proposalId: null,
    });
  });

  it("is null before the first setup, for an unplanned period and for an empty recurring setup", () => {
    expect(budgetInForce(setups, plans, "2024-12")).toBeNull();
    expect(budgetInForce(setups, plans, "2027-02")).toBeNull();
    expect(budgetInForce([{ ...setups[0]!, amounts: [] }], [], "2026-01")).toBeNull();
    expect(budgetInForce([], [], "2026-01")).toBeNull();
  });
});
