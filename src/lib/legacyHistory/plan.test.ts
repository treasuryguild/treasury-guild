import { describe, expect, it } from "vitest";
import { LegacyIssueCode as Code } from "@/lib/constants";
import { readHistoryCsv } from "./parse";
import {
  canonicalRow, legacyRpcRows, planLegacyImport, previewRows, resolveLegacyTicker, resolveLegacyWorkgroup, type PlanContext,
  type TickerContext,
} from "./plan";
import { LEGACY_CSV_TEMPLATE, LEGACY_CSV_TEMPLATE_NAME } from "./template";

const AGIX = "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc53541474958";
const OTHER_AGIX = "aa".repeat(28) + "41474958";
const TODAY = "2026-09-28";

const GOV = { id: "w-gov", name: "Governance Workgroup", archived: false };
const TREASURY = { id: "w-tg", name: "Treasury Guild", archived: false };

const noTickers: TickerContext = { registry: [], manual: new Map(), history: [], wallet: [] };

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    ...noTickers,
    wallet: [{ unit: AGIX, ticker: "AGIX", decimals: 8 }],
    aliases: new Map(),
    workgroups: [GOV, TREASURY],
    setups: new Map(),
    existingKeys: new Set(),
    hash: (canonical) => `h(${canonical})`,
    includeDuplicates: false,
    ...overrides,
  };
}

const CSV = [
  "userId,ADA,AGIX,task,date,workgroup",
  'f39ntm,,480,"Meeting documentation: 25th, 27th Aug",15.09.2026,governance-workgroup',
  "7xcueh,114.5,,Handling fee,15.08.26,treasury-guild",
  'rcgctj,80,0.00000001,"Meeting facilitation",08.09.2026,governance-workgroup',
].join("\n");

describe("resolveLegacyTicker", () => {
  it("resolves ADA, then the registry, the admin's unit, earlier imports and wallet tokens", () => {
    expect(resolveLegacyTicker("ada", noTickers)).toMatchObject({ status: "resolved", unit: "lovelace", decimals: 6, source: "ada" });
    expect(resolveLegacyTicker("AGIX", { ...noTickers, registry: [{ fieldName: "agix", unit: AGIX, decimals: 8 }] }))
      .toMatchObject({ status: "resolved", unit: AGIX, source: "registry" });
    expect(resolveLegacyTicker("AGIX", {
      ...noTickers,
      manual: new Map([["agix", { unit: AGIX, token: { unit: AGIX, ticker: "AGIX", decimals: 8 } }]]),
      wallet: [{ unit: OTHER_AGIX, ticker: "AGIX", decimals: 0 }],
    })).toMatchObject({ status: "resolved", unit: AGIX, source: "manual" });
    expect(resolveLegacyTicker("AGIX", { ...noTickers, history: [{ unit: AGIX, ticker: "agix", decimals: 8 }] }))
      .toMatchObject({ status: "resolved", unit: AGIX, source: "history" });
    expect(resolveLegacyTicker("AGIX", { ...noTickers, wallet: [{ unit: AGIX, ticker: "AGIX", decimals: 8 }] }))
      .toMatchObject({ status: "resolved", unit: AGIX, source: "wallet" });
  });

  it("asks when several tokens share the ticker or none has it", () => {
    const wallet = [{ unit: AGIX, ticker: "AGIX", decimals: 8 }, { unit: OTHER_AGIX, ticker: "AGIX", decimals: 0 }];
    expect(resolveLegacyTicker("AGIX", { ...noTickers, wallet })).toMatchObject({ status: "ambiguous" });
    expect(resolveLegacyTicker("SNEK", noTickers)).toEqual({ ticker: "SNEK", status: "unknown" });
    expect(resolveLegacyTicker("SNEK", { ...noTickers, manual: new Map([["snek", { unit: OTHER_AGIX, token: null }]]) }))
      .toEqual({ ticker: "SNEK", status: "unknown", manualUnit: OTHER_AGIX });
  });
});

describe("resolveLegacyWorkgroup", () => {
  const archivedGov = { id: "w-old", name: "governance workgroup", archived: true };

  it("matches normalized names, archived ones included", () => {
    expect(resolveLegacyWorkgroup("governance-workgroup", "x", new Map(), [GOV])).toMatchObject({ status: "resolved", workgroup: GOV });
    expect(resolveLegacyWorkgroup("governance-workgroup", "x", new Map(), [archivedGov]))
      .toMatchObject({ status: "resolved", workgroup: archivedGov });
    expect(resolveLegacyWorkgroup("governance-workgroup", "x", new Map(), [GOV, archivedGov]))
      .toMatchObject({ status: "resolved", workgroup: GOV });
    expect(resolveLegacyWorkgroup("governance-workgroup", "x", new Map(), [archivedGov, { ...archivedGov, id: "w-2" }]))
      .toMatchObject({ status: "ambiguous" });
    expect(resolveLegacyWorkgroup("ops", "Ops", new Map(), [GOV])).toEqual({ ref: "ops", name: "Ops", status: "missing" });
  });

  it("prefers an admin's alias", () => {
    expect(resolveLegacyWorkgroup("gov", "gov", new Map([["Gov", TREASURY.id]]), [GOV, TREASURY]))
      .toMatchObject({ status: "resolved", workgroup: TREASURY });
  });
});

describe("planLegacyImport", () => {
  it("scales amounts exactly, sets budget periods and totals", () => {
    const plan = planLegacyImport(readHistoryCsv(CSV, TODAY), context({
      setups: new Map([[GOV.id, [{ starts_on: "2026-01-01", cadence: "quarterly" as const }]]]),
    }));
    expect(plan.issues).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.rows.map((r) => [r.line, r.status, r.workgroupId, r.budgetMonth])).toEqual([
      [2, "new", GOV.id, "2026-07-01"],
      [3, "new", TREASURY.id, "2026-08-01"],
      [4, "new", GOV.id, "2026-07-01"],
    ]);
    expect(plan.rows[2]!.amounts.map((a) => a.quantity)).toEqual(["80000000", "1"]);
    expect(plan.totals).toEqual(expect.arrayContaining([
      { workgroupId: null, unit: AGIX, ticker: "AGIX", decimals: 8, amount: "48000000001" },
      { workgroupId: null, unit: "lovelace", ticker: "ADA", decimals: 6, amount: "194500000" },
      { workgroupId: TREASURY.id, unit: "lovelace", ticker: "ADA", decimals: 6, amount: "114500000" },
    ]));
    expect(legacyRpcRows(plan, false)[1]).toEqual({
      lineNo: 3,
      workgroupId: TREASURY.id,
      workgroupRef: "treasury-guild",
      recipientRef: "7xcueh",
      task: "Handling fee",
      paidOn: "2026-08-15",
      budgetMonth: "2026-08-01",
      dedupeKey: "h(7xcueh|treasury-guild|2026-08-15|handling fee|lovelace:114500000)",
      amounts: [{ unit: "lovelace", ticker: "ADA", decimals: 6, amount: "114500000" }],
    });
  });

  it("is not ready while a ticker or workgroup is unresolved", () => {
    const plan = planLegacyImport(readHistoryCsv(CSV, TODAY), context({ wallet: [], workgroups: [GOV] }));
    expect(plan.ready).toBe(false);
    expect(plan.issues.map((i) => i.code).sort()).toEqual([Code.UnresolvedTicker, Code.UnresolvedWorkgroup]);
    expect(legacyRpcRows(plan, false)).toEqual([]);
  });

  it("refuses more decimals than the token has", () => {
    const csv = "userId,ADA,task,date,workgroup\nacdefg,1.0000001,t,01.09.2026,treasury guild";
    const plan = planLegacyImport(readHistoryCsv(csv, TODAY), context());
    expect(plan.rows[0]!.status).toBe("invalid");
    expect(plan.issues).toEqual([{ code: Code.TooManyDecimals, line: 2, severity: "error", column: "ADA", value: "1.0000001" }]);
    expect(plan.ready).toBe(false);
  });

  it("skips lines already imported unless asked, and warns about repeats in the file", () => {
    const csv = "userId,ADA,task,date,workgroup\nacdefg,1,Fee,01.09.2026,ops\nacdefg,1,fee ,01.09.2026,Ops\nacdefg,2,Other,01.09.2026,ops";
    const ops = { id: "w-ops", name: "ops", archived: false };
    const held = `h(${canonicalRow({ recipientRef: "acdefg", workgroupRef: "ops", paidOn: "2026-09-01", task: "Other", amounts: [{ unit: "lovelace", quantity: "2000000" }] })})`;
    const plan = planLegacyImport(readHistoryCsv(csv, TODAY), context({ workgroups: [ops], existingKeys: new Set([held]) }));
    expect(plan.rows.map((r) => [r.status, r.duplicateOfLine])).toEqual([["new", null], ["new", 2], ["duplicate", null]]);
    expect(plan.issues).toEqual([{ code: Code.DuplicateInFile, line: 3, severity: "warning", value: "2" }]);
    expect(plan.counts).toEqual({ lines: 3, new: 2, duplicates: 1, fileDuplicates: 1, invalid: 0 });
    expect(legacyRpcRows(plan, false).map((r) => r.lineNo)).toEqual([2, 3]);

    const all = planLegacyImport(readHistoryCsv(csv, TODAY), context({ workgroups: [ops], existingKeys: new Set([held]), includeDuplicates: true }));
    expect(legacyRpcRows(all, true).map((r) => r.lineNo)).toEqual([2, 3, 4]);
  });

  it("has nothing to import when every line is already here", () => {
    const csv = "userId,ADA,task,date,workgroup\nacdefg,2,Other,01.09.2026,ops";
    const ops = { id: "w-ops", name: "ops", archived: false };
    const held = `h(${canonicalRow({ recipientRef: "acdefg", workgroupRef: "ops", paidOn: "2026-09-01", task: "Other", amounts: [{ unit: "lovelace", quantity: "2000000" }] })})`;
    expect(planLegacyImport(readHistoryCsv(csv, TODAY), context({ workgroups: [ops], existingKeys: new Set([held]) })).ready).toBe(false);
  });

  it("refuses two columns naming the same token", () => {
    const csv = "userId,AGIX,AGIX2,task,date,workgroup\nacdefg,1,2,t,01.09.2026,ops";
    const plan = planLegacyImport(readHistoryCsv(csv, TODAY), context({
      workgroups: [{ id: "w-ops", name: "ops", archived: false }],
      registry: [{ fieldName: "AGIX", unit: AGIX, decimals: 8 }, { fieldName: "AGIX2", unit: AGIX, decimals: 8 }],
    }));
    expect(plan.issues.map((i) => i.code)).toEqual([Code.SameToken]);
  });
});

describe("the downloadable CSV template", () => {
  it("parses with the real parser: both example lines, no issue", () => {
    const parsed = readHistoryCsv(LEGACY_CSV_TEMPLATE, TODAY);
    expect(parsed.issues).toEqual([]);
    expect(parsed.tickers).toEqual(["ADA", "AGIX"]);
    expect(parsed.lineCount).toBe(2);
    expect(parsed.rows).toEqual([
      {
        line: 2, recipientRef: "f39ntm", task: "Meeting documentation: 25th, 27th Aug", paidOn: "2026-09-15",
        workgroupRef: "governance-workgroup", workgroupName: "governance-workgroup", amounts: [{ ticker: "AGIX", raw: "480" }],
      },
      {
        line: 3, recipientRef: "7xcueh", task: "Contribution handling fee", paidOn: "2026-09-15",
        workgroupRef: "treasury-guild", workgroupName: "treasury-guild", amounts: [{ ticker: "ADA", raw: "114.5" }],
      },
    ]);
  });

  it("shows both date spellings and a quoted task with a comma", () => {
    // What the template is there to teach; the parse above proves each is accepted.
    expect(LEGACY_CSV_TEMPLATE).toContain("15.09.2026");
    expect(LEGACY_CSV_TEMPLATE).toContain("15.09.26");
    expect(LEGACY_CSV_TEMPLATE).toMatch(/"[^"\r\n]*,[^"\r\n]*"/);
    expect(LEGACY_CSV_TEMPLATE_NAME).toMatch(/\.csv$/);
  });

  it("plans without issues once its workgroups and tokens are known", () => {
    const plan = planLegacyImport(readHistoryCsv(LEGACY_CSV_TEMPLATE, TODAY), context());
    expect(plan.issues).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.tickers.map((t) => [t.ticker, t.status])).toEqual([["ADA", "resolved"], ["AGIX", "resolved"]]);
    expect(plan.workgroups.map((w) => w.status)).toEqual(["resolved", "resolved"]);
    expect(plan.rows.map((r) => [r.status, r.workgroupId, r.budgetMonth, r.amounts.map((a) => a.quantity)])).toEqual([
      ["new", GOV.id, "2026-09-01", ["48000000000"]],
      ["new", TREASURY.id, "2026-09-01", ["114500000"]],
    ]);
    expect(plan.counts).toEqual({ lines: 2, new: 2, duplicates: 0, fileDuplicates: 0, invalid: 0 });
    expect(legacyRpcRows(plan, false)).toHaveLength(2);
  });
});

describe("previewRows", () => {
  const ops = { id: "w-ops", name: "ops", archived: false };
  const line = (n: number, amount = "1") => `acdefg,${amount},Task ${n},01.09.2026,ops`;
  function planOf(lines: string[], overrides: Partial<PlanContext> = {}) {
    return planLegacyImport(readHistoryCsv(["userId,ADA,task,date,workgroup", ...lines].join("\n"), TODAY), context({ workgroups: [ops], ...overrides }));
  }
  const keyOf = (n: number) =>
    `h(${canonicalRow({ recipientRef: "acdefg", workgroupRef: "ops", paidOn: "2026-09-01", task: `Task ${n}`, amounts: [{ unit: "lovelace", quantity: "1000000" }] })})`;

  it("lists every row of a small clean plan, untruncated", () => {
    const plan = planOf([line(1), line(2), line(3)]);
    expect(previewRows(plan)).toEqual({ rows: plan.rows, truncated: false });
  });

  it("cuts clean rows at the limit, keeping the first ones in file order", () => {
    const plan = planOf([line(1), line(2), line(3), line(4), line(5)]);
    const preview = previewRows(plan, 3);
    expect(preview.rows.map((r) => r.line)).toEqual([2, 3, 4]);
    expect(preview.truncated).toBe(true);
    expect(previewRows(plan, 5)).toEqual({ rows: plan.rows, truncated: false });
    expect(previewRows(plan, 0)).toEqual({ rows: [], truncated: true });
  });

  it("defaults to 100 clean rows", () => {
    const plan = planOf(Array.from({ length: 101 }, (_, i) => line(i + 1)));
    expect(plan.rows).toHaveLength(101);
    const preview = previewRows(plan);
    expect(preview.rows).toHaveLength(100);
    expect(preview.rows.at(-1)!.line).toBe(101);
    expect(preview.truncated).toBe(true);
    expect(previewRows(planOf(Array.from({ length: 100 }, (_, i) => line(i + 1)))).truncated).toBe(false);
  });

  it("always lists rows that need attention, beyond and outside the clean limit", () => {
    // Line 3 is already imported, line 5 repeats line 2, line 6 has too many decimals.
    const plan = planOf(
      [line(1), line(2), line(3), line(1), line(4, "1.0000001"), line(5)],
      { existingKeys: new Set([keyOf(2)]) },
    );
    expect(plan.rows.map((r) => [r.line, r.status, r.duplicateOfLine])).toEqual([
      [2, "new", null], [3, "duplicate", null], [4, "new", null], [5, "new", 2], [6, "invalid", null], [7, "new", null],
    ]);
    const preview = previewRows(plan, 1);
    // One clean row (line 2), then every flagged one, in file order; clean lines 4 and 7 are dropped.
    expect(preview.rows.map((r) => r.line)).toEqual([2, 3, 5, 6]);
    expect(preview.truncated).toBe(true);
    expect(previewRows(plan, 0).rows.map((r) => r.line)).toEqual([3, 5, 6]);
    // Flagged rows do not use up the clean allowance.
    expect(previewRows(plan, 3)).toEqual({ rows: plan.rows, truncated: false });
  });

  it("does not treat a file-level issue as flagging any row", () => {
    const archived = { id: "w-ops", name: "ops", archived: true };
    const plan = planOf([line(1), line(2)], { workgroups: [archived] });
    expect(plan.issues).toEqual([{ code: Code.ArchivedWorkgroup, line: null, severity: "warning", value: "ops" }]);
    expect(previewRows(plan, 1).rows.map((r) => r.line)).toEqual([2]);
  });

  it("never returns more than 500 rows", () => {
    const lines = Array.from({ length: 600 }, (_, i) => line(i + 1));
    const held = new Set(Array.from({ length: 600 }, (_, i) => keyOf(i + 1)));
    const plan = planOf(lines, { existingKeys: held });
    expect(plan.rows.every((r) => r.status === "duplicate")).toBe(true);
    const preview = previewRows(plan);
    expect(preview.rows).toHaveLength(500);
    expect(preview.rows.at(-1)!.line).toBe(501);
  });

  it("reports the list as truncated when the 500-row cap cut it", () => {
    // 600 lines this wallet already holds: all flagged, so none is dropped by
    // the clean limit, but only 500 of them are returned.
    const lines = Array.from({ length: 600 }, (_, i) => line(i + 1));
    const held = new Set(Array.from({ length: 600 }, (_, i) => keyOf(i + 1)));
    const plan = planOf(lines, { existingKeys: held });
    const preview = previewRows(plan);
    expect(preview.rows.length).toBeLessThan(plan.rows.length);
    expect(preview.truncated).toBe(true);
  });
});
