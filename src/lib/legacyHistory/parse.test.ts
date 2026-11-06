import { describe, expect, it } from "vitest";
import { LEGACY_MAX_ROWS, LegacyIssueCode as Code } from "@/lib/constants";
import {
  isTickerHeader, normalizeRecipientRef, normalizeWorkgroupName, parseAmountCell, parseHistoryDate, readHistoryCsv,
} from "./parse";

const TODAY = "2026-09-28";
const HEADER = "userId,ADA,AGIX,task,date,workgroup,txHash,outputIndex";
const ADDR1 = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae";
const ADDR2 = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const ADDR3 = "addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const TX1 = "a".repeat(64);
const TX2 = "b".repeat(64);
const TX3 = "c".repeat(64);

const SAMPLE = [
  HEADER,
  `${ADDR1},,480,"Meeting documentation: 25th, 27th Aug and 1st, 3rd,",15.09.2026,governance-workgroup,${TX1},0`,
  `${ADDR2},114.5,,singularitynet contribution handling fee,15.09.26,treasury-guild,${TX2},0`,
  `${ADDR3},80,0.25,"Meeting documentation, 11th Aug 2026",09.09.2026,Governance Workgroup,${TX3},1`,
].join("\n");

describe("parseHistoryDate", () => {
  it.each([
    ["15.09.2026", "2026-09-15"],
    ["15.09.26", "2026-09-15"],
    ["1.2.2025", "2025-02-01"],
    ["2026-09-03", "2026-09-03"],
    ["15/09/2026", "2026-09-15"],
    ["09/15/2026", "2026-09-15"],
  ])("reads %s", (raw, expected) => expect(parseHistoryDate(raw)).toBe(expected));

  it.each(["31.02.2026", "03/09/2026", "2026-9-3", "15.13.2026", "01.01.2016", "", "yesterday"])(
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

  it("accepts a full Shelley address or a bech32 address suffix, lowercased", () => {
    expect(normalizeRecipientRef(` ${ADDR1} `)).toBe(ADDR1);
    expect(normalizeRecipientRef("f39ntm")).toBe("f39ntm");
    expect(normalizeRecipientRef("F39NTM")).toBe("f39ntm");
    expect(normalizeRecipientRef("abc12")).toBeNull();
    expect(normalizeRecipientRef("short")).toBeNull();
    expect(normalizeRecipientRef("has1one")).toBeNull();
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
        recipientRef: ADDR1,
        task: "Meeting documentation: 25th, 27th Aug and 1st, 3rd,",
        paidOn: "2026-09-15",
        workgroupRef: "governance-workgroup",
        workgroupName: "governance-workgroup",
        txHash: TX1,
        outputIndex: 0,
        amounts: [{ ticker: "AGIX", raw: "480" }],
      },
      {
        line: 3,
        recipientRef: ADDR2,
        task: "singularitynet contribution handling fee",
        paidOn: "2026-09-15",
        workgroupRef: "treasury-guild",
        workgroupName: "treasury-guild",
        txHash: TX2,
        outputIndex: 0,
        amounts: [{ ticker: "ADA", raw: "114.5" }],
      },
      {
        line: 4,
        recipientRef: ADDR3,
        task: "Meeting documentation, 11th Aug 2026",
        paidOn: "2026-09-09",
        workgroupRef: "governance-workgroup",
        workgroupName: "Governance Workgroup",
        txHash: TX3,
        outputIndex: 1,
        amounts: [{ ticker: "ADA", raw: "80" }, { ticker: "AGIX", raw: "0.25" }],
      },
    ]);
  });

  it("matches headers in any case and order and ignores spreadsheet padding", () => {
    const parsed = readHistoryCsv(
      `Workgroup,Date,Task,ADA,User ID,txHash,outputIndex\nops,01.09.2026,Fee,5,${ADDR1},${TX1},0\n,,,,,,,,\n`,
      TODAY,
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.recipientRef).toBe(ADDR1);
  });

  it("accepts the last 6+ characters of an address as userId", () => {
    const tail = ADDR1.slice(-6);
    const parsed = readHistoryCsv(
      `${HEADER}\n${tail},1,,t,01.09.2026,ops,${TX1},0`,
      TODAY,
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.recipientRef).toBe(tail);
  });

  it("accepts a missing or blank outputIndex column", () => {
    const noColumn = readHistoryCsv(
      `userId,ADA,task,date,workgroup,txHash\n${ADDR1},1,t,01.09.2026,ops,${TX1}`,
      TODAY,
    );
    expect(noColumn.issues).toEqual([]);
    expect(noColumn.rows[0]!.outputIndex).toBeNull();

    const blank = readHistoryCsv(
      `${HEADER}\n${ADDR1},1,,t,01.09.2026,ops,${TX1},`,
      TODAY,
    );
    expect(blank.issues).toEqual([]);
    expect(blank.rows[0]!.outputIndex).toBeNull();
  });

  it("still refuses a non-blank invalid outputIndex", () => {
    const parsed = readHistoryCsv(
      `${HEADER}\n${ADDR1},1,,t,01.09.2026,ops,${TX1},x`,
      TODAY,
    );
    expect(parsed.rows).toEqual([]);
    expect(parsed.issues).toEqual([{ code: Code.BadOutputIndex, line: 2, severity: "error", value: "x" }]);
  });

  it("reads a file past the old 5000-row cap and refuses one past the ceiling", () => {
    const csv = (rows: number) => [
      HEADER,
      ...Array.from({ length: rows }, () => `${ADDR1},1,,t,01.09.2026,ops,${TX1},0`),
    ].join("\n");
    const accepted = readHistoryCsv(csv(5001), TODAY);
    expect(accepted.issues).toEqual([]);
    expect(accepted.rows).toHaveLength(5001);

    const refused = readHistoryCsv(csv(LEGACY_MAX_ROWS + 1), TODAY);
    expect(refused.rows).toEqual([]);
    expect(refused.lineCount).toBe(LEGACY_MAX_ROWS + 1);
    expect(refused.issues).toEqual([{ code: Code.TooManyRows, line: null, severity: "error", value: String(LEGACY_MAX_ROWS + 1) }]);
  });

  it("reports header problems for the whole file", () => {
    const codes = (csv: string) => readHistoryCsv(csv, TODAY).issues.map((i) => i.code);
    expect(codes("")).toEqual([Code.EmptyFile]);
    expect(codes(`userId,task,date,workgroup,txHash,outputIndex\n${ADDR1},x,t,01.09.2026,ops,${TX1},0`)).toEqual([Code.NoTickerColumns]);
    expect(codes(`userId,amount!,task,date,workgroup,txHash,outputIndex\n${ADDR1},1,t,01.09.2026,ops,${TX1},0`)).toEqual([Code.BadTickerColumn, Code.NoTickerColumns]);
    expect(codes(`userId,ADA,ada,task,date,workgroup,txHash,outputIndex\n${ADDR1},1,1,t,01.09.2026,ops,${TX1},0`)).toEqual([Code.DuplicateColumn]);
    expect(codes(`userId,ADA,task,date\n${ADDR1},1,t,01.09.2026`)).toEqual([
      Code.MissingColumn,
      Code.MissingColumn,
    ]);
    expect(codes(`userId,ADA,task,date,workgroup,txHash,outputIndex,\n${ADDR1},1,t,01.09.2026,ops,${TX1},0,x`)).toEqual([Code.UnnamedColumn]);
  });

  it("reports each bad line and leaves it out", () => {
    const csv = [
      HEADER,
      `not-an-address,1,,t,01.09.2026,ops,${TX1},0`,
      `${ADDR1},1,,,01.09.2026,ops,${TX1},0`,
      `${ADDR1},1,,t,03/09/2026,ops,${TX1},0`,
      `${ADDR1},1,,t,01.10.2026,ops,${TX1},0`,
      `${ADDR1},1,,t,extra,01.09.2026,ops,${TX1},0`,
      `${ADDR1},1;;5,,t,01.09.2026,ops,${TX1},0`,
      `${ADDR1},,,t,01.09.2026,ops,${TX1},0`,
      `${ADDR1},1,,t,01.09.2026,,${TX1},0`,
      `${ADDR1},2,,fine,01.09.2026,ops,${TX2},0`,
    ].join("\n");
    const parsed = readHistoryCsv(csv, TODAY);
    expect(parsed.issues.map((i) => [i.line, i.code])).toEqual([
      [2, Code.BadRecipient],
      [3, Code.EmptyTask],
      [4, Code.BadDate],
      [5, Code.FutureDate],
      [6, Code.FieldCount],
      [6, Code.BadDate],
      [6, Code.BadTxHash],
      [6, Code.BadOutputIndex],
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
    const parsed = readHistoryCsv(`userId, AGIX2 ,USDC.e,task,date,workgroup,txHash,outputIndex\n${ADDR1},1,2,t,01.09.2026,ops,${TX1},0`, TODAY);
    expect(parsed.issues).toEqual([]);
    expect(parsed.tickers).toEqual(["AGIX2", "USDC.e"]);
    const bad = readHistoryCsv(`userId,AGIX,$NEK,task,date,workgroup,txHash,outputIndex\n${ADDR1},1,2,t,01.09.2026,ops,${TX1},0`, TODAY);
    expect(bad.issues).toEqual([{ code: Code.BadTickerColumn, line: null, severity: "error", column: "$NEK" }]);
  });

  it("is not asked about the required columns, whose names would pass", () => {
    // "task" and "date" look like tickers; the reader takes them as columns first.
    expect(isTickerHeader("task")).toBe(true);
    const parsed = readHistoryCsv(`userId,ADA,task,date,workgroup,txHash,outputIndex\n${ADDR1},1,t,01.09.2026,ops,${TX1},0`, TODAY);
    expect(parsed.tickers).toEqual(["ADA"]);
  });
});
