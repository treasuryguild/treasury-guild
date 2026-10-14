import { describe, expect, it } from "vitest";
import { LegacyIssueCode as Code } from "@/lib/constants";
import {
  isTickerHeader, normalizeRecipientRef, normalizeWorkgroupName, parseAmountCell, parseHistoryDate, readHistoryCsv,
} from "./parse";

const TODAY = "2026-09-28";

const SAMPLE = [
  "userId,ADA,AGIX,task,date,workgroup",
  'f39ntm,,480,"Meeting documentation: 25th, 27th Aug and 1st, 3rd,",15.09.2026,governance-workgroup',
  "7xcueh,114.5,,singularitynet contribution handling fee,15.09.26,treasury-guild",
  'rcgctj,80,0.25,"Meeting documentation, 11th Aug 2026",09.09.2026,Governance Workgroup',
].join("\n");

describe("parseHistoryDate", () => {
  it.each([
    ["15.09.2026", "2026-09-15"],
    ["15.09.26", "2026-09-15"],
    ["1.2.2025", "2025-02-01"],
    ["2026-09-03", "2026-09-03"],
  ])("reads %s", (raw, expected) => expect(parseHistoryDate(raw)).toBe(expected));

  it.each(["31.02.2026", "15/09/2026", "2026-9-3", "15.13.2026", "01.01.2016", "", "yesterday"])(
    "refuses %s",
    (raw) => expect(parseHistoryDate(raw)).toBeNull(),
  );
});

describe("parseAmountCell", () => {
  it.each([
    ["480", "480"],
    ["114.50", "114.5"],
    [".5", "0.5"],
    ["007", "7"],
    ["480.", "480"],
  ])("reads %s", (raw, value) => expect(parseAmountCell(raw)).toEqual({ kind: "amount", value }));

  it("treats empty and zero as none", () => {
    expect(parseAmountCell(" ")).toEqual({ kind: "none" });
    expect(parseAmountCell("0.00")).toEqual({ kind: "none" });
  });

  it("refuses commas, signs and exponents", () => {
    expect(parseAmountCell("1,5")).toEqual({ kind: "error", code: Code.AmountComma });
    expect(parseAmountCell("-5")).toEqual({ kind: "error", code: Code.BadAmount });
    expect(parseAmountCell("1e6")).toEqual({ kind: "error", code: Code.BadAmount });
    expect(parseAmountCell(".")).toEqual({ kind: "error", code: Code.BadAmount });
  });
});

describe("normalizers", () => {
  it("normalizes workgroup names", () => {
    expect(normalizeWorkgroupName("  Governance  Workgroup ")).toBe("governance-workgroup");
    expect(normalizeWorkgroupName("treasury_guild")).toBe("treasury-guild");
    expect(normalizeWorkgroupName("--a--b--")).toBe("a-b");
  });

  it("accepts an address end or a whole address, lowercased", () => {
    expect(normalizeRecipientRef(" F39NTM ")).toBe("f39ntm");
    expect(normalizeRecipientRef("addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae"))
      .toMatch(/^addr_test1/);
    expect(normalizeRecipientRef("abc12")).toBeNull();
    expect(normalizeRecipientRef("f3bntm")).toBeNull();
  });
});

describe("readHistoryCsv", () => {
  it("reads the sample format with ticker columns", () => {
    const parsed = readHistoryCsv(SAMPLE, TODAY);
    expect(parsed.issues).toEqual([]);
    expect(parsed.tickers).toEqual(["ADA", "AGIX"]);
    expect(parsed.lineCount).toBe(3);
    expect(parsed.rows).toEqual([
      {
        line: 2,
        recipientRef: "f39ntm",
        task: "Meeting documentation: 25th, 27th Aug and 1st, 3rd,",
        paidOn: "2026-09-15",
        workgroupRef: "governance-workgroup",
        workgroupName: "governance-workgroup",
        amounts: [{ ticker: "AGIX", raw: "480" }],
      },
      {
        line: 3,
        recipientRef: "7xcueh",
        task: "singularitynet contribution handling fee",
        paidOn: "2026-09-15",
        workgroupRef: "treasury-guild",
        workgroupName: "treasury-guild",
        amounts: [{ ticker: "ADA", raw: "114.5" }],
      },
      {
        line: 4,
        recipientRef: "rcgctj",
        task: "Meeting documentation, 11th Aug 2026",
        paidOn: "2026-09-09",
        workgroupRef: "governance-workgroup",
        workgroupName: "Governance Workgroup",
        amounts: [{ ticker: "ADA", raw: "80" }, { ticker: "AGIX", raw: "0.25" }],
      },
    ]);
  });

  it("matches headers in any case and order and ignores spreadsheet padding", () => {
    const parsed = readHistoryCsv("Workgroup,Date,Task,ADA,User ID,\nops,01.09.2026,Fee,5,acdefg,\n,,,,,\n", TODAY);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.recipientRef).toBe("acdefg");
  });

  it("reports header problems for the whole file", () => {
    const codes = (csv: string) => readHistoryCsv(csv, TODAY).issues.map((i) => i.code);
    expect(codes("")).toEqual([Code.EmptyFile]);
    expect(codes("userId,task,date,workgroup\nacdefg,t,01.09.2026,ops")).toEqual([Code.NoTickerColumns]);
    expect(codes("userId,amount!,task,date,workgroup\nacdefg,1,t,01.09.2026,ops")).toEqual([Code.BadTickerColumn, Code.NoTickerColumns]);
    expect(codes("userId,ADA,ada,task,date,workgroup\nacdefg,1,1,t,01.09.2026,ops")).toEqual([Code.DuplicateColumn]);
    expect(codes("userId,ADA,task,date\nacdefg,1,t,01.09.2026")).toEqual([Code.MissingColumn]);
    expect(codes("userId,ADA,task,date,workgroup,\nacdefg,1,t,01.09.2026,ops,x")).toEqual([Code.UnnamedColumn]);
  });

  it("reports each bad line and leaves it out", () => {
    const csv = [
      "userId,ADA,task,date,workgroup",
      "abc,1,t,01.09.2026,ops",
      "acdefg,1,,01.09.2026,ops",
      "acdefg,1,t,03/09/2026,ops",
      "acdefg,1,t,01.10.2026,ops",
      "acdefg,1,5,t,01.09.2026,ops",
      "acdefg,1;5,t,01.09.2026,ops",
      "acdefg,,t,01.09.2026,ops",
      "acdefg,1,t,01.09.2026,",
      "acdefg,2,fine,01.09.2026,ops",
    ].join("\n");
    const parsed = readHistoryCsv(csv, TODAY);
    expect(parsed.issues.map((i) => [i.line, i.code])).toEqual([
      [2, Code.BadRecipient],
      [3, Code.EmptyTask],
      [4, Code.BadDate],
      [5, Code.FutureDate],
      [6, Code.FieldCount],
      [6, Code.BadDate],
      [7, Code.BadAmount],
      [8, Code.NoAmount],
      [9, Code.EmptyWorkgroup],
    ]);
    expect(parsed.rows.map((r) => r.line)).toEqual([10]);
  });
});

describe("isTickerHeader", () => {
  it.each(["ADA", "agix", "AGIX2", "9INE", "USDC.e", "w-ADA", "MY_TOKEN", "A", "a".repeat(32)])(
    "accepts %s",
    (cell) => expect(isTickerHeader(cell)).toBe(true),
  );

  it.each([
    "", " ", "ADA ", " ADA", "A B", "$ADA", "ADA!", "₳", "tökens",
    ".ADA", "-ADA", "_ADA", "ADA,AGIX", "a".repeat(33),
  ])("refuses %j", (cell) => expect(isTickerHeader(cell)).toBe(false));

  it("decides which header cells become ticker columns (the cell is trimmed first)", () => {
    const parsed = readHistoryCsv("userId, AGIX2 ,USDC.e,task,date,workgroup\nacdefg,1,2,t,01.09.2026,ops", TODAY);
    expect(parsed.issues).toEqual([]);
    expect(parsed.tickers).toEqual(["AGIX2", "USDC.e"]);
    const bad = readHistoryCsv("userId,AGIX,$NEK,task,date,workgroup\nacdefg,1,2,t,01.09.2026,ops", TODAY);
    expect(bad.issues).toEqual([{ code: Code.BadTickerColumn, line: null, severity: "error", column: "$NEK" }]);
  });

  it("is not asked about the required columns, whose names would pass", () => {
    // "task" and "date" look like tickers; the reader takes them as columns first.
    expect(isTickerHeader("task")).toBe(true);
    const parsed = readHistoryCsv("userId,ADA,task,date,workgroup\nacdefg,1,t,01.09.2026,ops", TODAY);
    expect(parsed.tickers).toEqual(["ADA"]);
  });
});
