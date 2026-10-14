import { describe, expect, it } from "vitest";
import type { BudgetSummary } from "@/lib/api/types";
import {
  acceptBudgetDraft, budgetDraftPayload, budgetDraftRows, budgetRowBlank, budgetRowChanged,
  budgetRowError, copyPeriodBudgets, draftRowKey,
  budgetRowNeedsSave, budgetSaveBodies,
} from "./budgetDrafts";

function budget(change: Partial<BudgetSummary> = {}): BudgetSummary {
  return {
    id: "b", ownerType: "workgroup", ownerId: "design", ownerName: "Design", treasuryId: null, workgroupKind: "native",
    budgetMonth: "2026-09", unit: "lovelace", assetLabel: "ADA", decimals: 6,
    cadence: "monthly", amount: "100000000", spent: "0", balance: "100000000",
    periodStart: "2026-09-01T00:00:00Z", periodEnd: "2026-10-01T00:00:00Z",
    periodLabel: "September 2026", ...change,
  };
}

describe("budget worksheet drafts", () => {
  it.each(["monthly", "quarterly"] as const)("saves unchanged %s defaults with one plan action", (cadence) => {
    const source = budget({ budgetMonth: null, cadence });
    const rows = budgetDraftRows([source], "2026-10", cadence);
    expect(rows.some(budgetRowChanged)).toBe(false);
    expect(budgetRowNeedsSave(rows[0]!, true, cadence)).toBe(true);
    expect(budgetDraftPayload(rows, true, cadence)).toEqual([{ unit: "lovelace", cadence, amount: "100000000" }]);
    const accepted = acceptBudgetDraft(rows, true, cadence);
    expect(accepted[0]!.persisted).toBe(true);
    expect(budgetRowNeedsSave(accepted[0]!, true, cadence)).toBe(false);
  });

  it("copies quarterly allocations without importing monthly amounts", () => {
    const rows = copyPeriodBudgets([], [budget(), budget({ unit: "quarter-token", cadence: "quarterly" })], "quarterly");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cadence).toBe("quarterly");
    expect(rows[0]?.asset.unit).toBe("quarter-token");
  });
  it("saves a changed default without materializing untouched defaults", () => {
    const rows = budgetDraftRows([
      budget({ budgetMonth: null }),
      budget({ id: "other", budgetMonth: null, unit: "token", decimals: 0, amount: "500" }),
    ], "2026-09");
    expect(rows.some(budgetRowChanged)).toBe(false);
    const edited = rows.map((row, index) => index === 0 ? { ...row, amount: "150" } : row);
    expect(budgetDraftPayload(edited)).toEqual([{ unit: "lovelace", cadence: "monthly", amount: "150000000" }]);
  });

  it("retains untouched saved tokens when replacing one project's set", () => {
    const rows = budgetDraftRows([budget(), budget({ unit: "token", decimals: 0, amount: "20" })], "2026-09");
    rows[0]!.amount = "150";
    expect(budgetDraftPayload(rows)).toHaveLength(2);
    rows[1]!.removed = true;
    expect(budgetDraftPayload(rows)).toEqual([{ unit: "lovelace", cadence: "monthly", amount: "150000000" }]);
  });

  it("can undo deletion and recognizes numerically equivalent amounts", () => {
    const row = budgetDraftRows([budget()], "2026-09")[0]!;
    expect(budgetRowChanged({ ...row, amount: "100.00" })).toBe(false);
    expect(budgetRowChanged({ ...row, removed: true })).toBe(true);
    expect(budgetRowChanged({ ...row, removed: false })).toBe(false);
  });

  it("validates blank, negative, excessive precision and overflowing quantities", () => {
    const row = budgetDraftRows([budget()], "2026-09")[0]!;
    for (const amount of ["", "0", "-1", "abc", "1.1234567", "9223372036854.775808"]) {
      expect(budgetRowError({ ...row, amount })).not.toBeNull();
    }
    expect(budgetRowError({ ...row, amount: "150.123456" })).toBeNull();
    expect(budgetRowError({ ...row, amount: "", removed: true })).toBeNull();
  });

  it("saves quarterly recurring changes while monthly overrides use a monthly cadence", () => {
    const source = budget({ budgetMonth: null, cadence: "quarterly" });
    const recurring = budgetDraftRows([source], null);
    recurring[0]!.amount = "200";
    expect(budgetDraftPayload(recurring)[0]?.cadence).toBe("quarterly");
    const monthly = budgetDraftRows([source], "2026-09");
    monthly[0]!.amount = "50";
    expect(budgetDraftPayload(monthly)[0]?.cadence).toBe("monthly");
  });

  it("copies missing monthly allocations without overwriting saved values or edits", () => {
    const current = budgetDraftRows([
      budget(),
      budget({ unit: "edited", budgetMonth: null }),
      budget({ unit: "default", budgetMonth: null }),
    ], "2026-09");
    current[1]!.amount = "125";
    const result = copyPeriodBudgets(current, [
      budget({ budgetMonth: "2026-08", amount: "200000000" }),
      budget({ unit: "edited", amount: "200000000" }),
      budget({ unit: "default", amount: "80000000" }),
      budget({ unit: "new", amount: "300000000" }),
      budget({ unit: "quarter", cadence: "quarterly" }),
    ]);
    expect(result.map((row) => [row.asset.unit, row.amount, row.copied])).toEqual([
      ["lovelace", "100", false], ["edited", "125", false],
      ["default", "80", true], ["new", "300", true],
    ]);
    expect(budgetDraftPayload(result)).toHaveLength(4);
  });

  it("makes copied default values explicit monthly snapshots even if the amount is unchanged", () => {
    const inherited = budget({ budgetMonth: null });
    const copied = copyPeriodBudgets(budgetDraftRows([inherited], "2026-09"), [inherited]);
    expect(copied.some(budgetRowChanged)).toBe(true);
    expect(budgetDraftPayload(copied)).toHaveLength(1);
  });

  it("keys rows by token and period so a quarter grid can hold three months of one token", () => {
    const rows = ["2026-07", "2026-08"].flatMap((month) => budgetDraftRows([budget({ budgetMonth: month })], month));
    expect(rows.map((row) => row.key)).toEqual(["lovelace:2026-07", "lovelace:2026-08"]);
    expect(rows.every((row) => row.persisted)).toBe(true);
    expect(budgetDraftRows([budget({ budgetMonth: null })], null, "monthly", "2026-09")[0]?.month).toBe("2026-09");
  });

  it("treats a freshly added token with no amount as nothing to change, save or validate", () => {
    const blank = { ...budgetDraftRows([budget()], "2026-09")[0]!, amount: "", original: null, persisted: false, source: null };
    expect(budgetRowBlank(blank)).toBe(true);
    expect(budgetRowChanged(blank)).toBe(false);
    expect(budgetRowError(blank, true)).toBeNull();
    expect(budgetDraftPayload([blank], true)).toEqual([]);
    expect(acceptBudgetDraft([blank], true)).toEqual([]);
    expect(budgetRowChanged({ ...blank, amount: "5" })).toBe(true);
    expect(budgetRowChanged({ ...blank, copied: true })).toBe(true);
  });

  it("copies month to month inside a quarter without touching other cells", () => {
    const current = ["2026-07", "2026-08", "2026-09"].flatMap((month) => budgetDraftRows([budget({ budgetMonth: null })], month));
    const source = [
      budget({ budgetMonth: "2026-04", periodStart: "2026-04-01T00:00:00Z", amount: "400000000" }),
      budget({ budgetMonth: "2026-05", periodStart: "2026-05-01T00:00:00Z", amount: "500", unit: "token", decimals: 0 }),
    ];
    let result = copyPeriodBudgets(current, source, "monthly", "2026-07", "2026-04");
    result = copyPeriodBudgets(result, source, "monthly", "2026-08", "2026-05");
    result = copyPeriodBudgets(result, source, "monthly", "2026-09", "2026-06");
    expect(result.map((row) => [row.key, row.amount, row.copied])).toEqual([
      ["lovelace:2026-07", "400", true], ["lovelace:2026-08", "100", false], ["lovelace:2026-09", "100", false],
      ["token:2026-08", "500", true],
    ]);
  });

  it("marks only accepted project saves clean and preserves failed drafts for retry", () => {
    const first = budgetDraftRows([budget()], "2026-09");
    const second = budgetDraftRows([budget({ ownerId: "engineering" })], "2026-09");
    first[0]!.amount = "120";
    second[0]!.amount = "180";
    const accepted = acceptBudgetDraft(first);
    expect(accepted.some(budgetRowChanged)).toBe(false);
    expect(second.some(budgetRowChanged)).toBe(true);
    accepted[0]!.amount = "130";
    expect(budgetDraftPayload(accepted)[0]?.amount).toBe("130000000");
  });
});

describe("budgetSaveBodies", () => {
  const rows = (month: string) => budgetDraftRows([budget({ budgetMonth: month, periodStart: `${month}-01T00:00:00Z` })], month)
    .map((row) => ({ ...row, amount: "150" }));

  it("puts a staged setup change and its reason on the first save only", () => {
    const bodies = budgetSaveBodies({ workgroupId: "design" }, [
      { month: "2026-07", rows: rows("2026-07"), mode: "monthly", cadence: "monthly" },
      { month: "2026-08", rows: rows("2026-08"), mode: "monthly", cadence: "monthly" },
    ], { startsOn: "2026-06", reason: "New setup" }, true);
    expect(bodies.map((b) => [b.startsOn, b.budgetMonth, b.confirmTransition, b.reason])).toEqual([
      ["2026-06", "2026-07", true, "New setup"],
      ["2026-08", "2026-08", false, ""],
    ]);
    expect(bodies[0]).toMatchObject({ workgroupId: "design", budgets: [{ unit: "lovelace", amount: "150000000" }] });
  });

  it("saves recurring amounts from the setup's start, without a budget month", () => {
    const [body] = budgetSaveBodies({ treasuryId: "t1" },
      [{ month: "2026-09", rows: rows("2026-09"), mode: "recurring", cadence: "monthly" }],
      { startsOn: "2026-10", reason: "" }, false);
    expect(body).toMatchObject({ treasuryId: "t1", budgetMonth: null, startsOn: "2026-10", confirmTransition: false });
  });
});

describe("draftRowKey", () => {
  it("is the unit and the period month, so one token has one row per period cell", () => {
    expect(draftRowKey("lovelace", "2026-09")).toBe("lovelace:2026-09");
    expect(draftRowKey("lovelace", "2026-09")).not.toBe(draftRowKey("lovelace", "2026-10"));
    expect(draftRowKey("lovelace", "2026-09")).not.toBe(draftRowKey("token", "2026-09"));
    // The recurring view has no month of its own.
    expect(draftRowKey("lovelace", "")).toBe("lovelace:");
  });

  it("is the key of the rows the worksheet builds and copies", () => {
    const [dated] = budgetDraftRows([budget()], "2026-09");
    expect(dated!.key).toBe(draftRowKey("lovelace", "2026-09"));
    const [recurring] = budgetDraftRows([budget({ budgetMonth: null })], null, "monthly", "2026-11");
    expect(recurring!.key).toBe(draftRowKey("lovelace", "2026-11"));
    const copied = copyPeriodBudgets([], [budget({ unit: "token" })], "monthly", "2026-10", "2026-09");
    expect(copied.map((row) => row.key)).toEqual([draftRowKey("token", "2026-10")]);
  });
});
