import { describe, expect, it } from "vitest";
import { readHistoryCsv } from "./parse";
import { applyHistoryColumnMap, type HistoryColumnMap } from "./map";

const TODAY = "2026-12-31";
const ADDR = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae";
const TX = "a".repeat(64);

const mapped = (overrides: Partial<HistoryColumnMap>): HistoryColumnMap => ({
  recipient: 0,
  task: 1,
  date: 2,
  workgroup: 3,
  txHash: 6,
  outputIndex: 7,
  amounts: [{ index: 4, ticker: "ADA" }],
  skip: [],
  ...overrides,
});

describe("applyHistoryColumnMap", () => {
  it("rewrites renamed headers into the history CSV and drops a skipped column", () => {
    const text = `Wallet,What,Paid,Team,Note,ADA,txHash,outputIndex\n${ADDR},\"Fee, docs\",15.09.2026,ops,ignore,10,${TX},0\n`;
    const result = applyHistoryColumnMap(text, mapped({
      recipient: 0, task: 1, date: 2, workgroup: 3, skip: [4], amounts: [{ index: 5, ticker: "ADA" }], txHash: 6, outputIndex: 7,
    }));
    expect(result.questions).toEqual([]);
    const parsed = readHistoryCsv(result.csv!, TODAY);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      recipientRef: ADDR, task: "Fee, docs", paidOn: "2026-09-15", workgroupName: "ops",
      amounts: [{ ticker: "ADA", raw: "10" }],
    });
  });

  it("asks about a name column and does not invent an address", () => {
    const text = "Name,ADA,task,date,workgroup,txHash,outputIndex\nAlice,10,Fee,15.09.2026,ops,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,0\n";
    const guessed = applyHistoryColumnMap(text, null);
    expect(guessed.csv).toBeNull();
    expect(guessed.questions.map((q) => q.message).join(" ")).toMatch(/Alice/);
    expect(guessed.questions.map((q) => q.message).join(" ")).toMatch(/address/i);

    const forced = applyHistoryColumnMap(text, mapped({
      recipient: 0, amounts: [{ index: 1, ticker: "ADA" }], task: 2, date: 3, workgroup: 4, txHash: 5, outputIndex: 6,
    }));
    expect(forced.csv).toBeNull();
    expect(forced.questions.some((q) => q.message.includes("Alice"))).toBe(true);
    expect(forced.csv ?? "").not.toContain("Alice");
  });

  it("reads a file that is already in the history shape without being told the columns", () => {
    const text = `userId,ADA,task,date,workgroup,txHash,outputIndex\n${ADDR},114.5,Fee,15.09.26,governance-workgroup,${TX},0\n`;
    const result = applyHistoryColumnMap(text, null);
    expect(result.questions).toEqual([]);
    const parsed = readHistoryCsv(result.csv!, TODAY);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.tickers).toEqual(["ADA"]);
  });

  it("does not require an outputIndex column when remapping", () => {
    const text = `userId,ADA,task,date,workgroup,txHash\n${ADDR},1,Fee,15.09.2026,ops,${TX}\n`;
    const result = applyHistoryColumnMap(text, null);
    expect(result.questions).toEqual([]);
    expect(result.csv).toContain("txHash");
    expect(result.csv).not.toContain("outputIndex");
    const parsed = readHistoryCsv(result.csv!, TODAY);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows[0]!.outputIndex).toBeNull();
  });

  it("asks which field an extra column is, until it is skipped", () => {
    const text = `userId,ADA,task,date,workgroup,txHash,outputIndex,Internal note\n${ADDR},1,Fee,15.09.2026,ops,${TX},0,hello\n`;
    const open = applyHistoryColumnMap(text, null);
    expect(open.csv).toBeNull();
    expect(open.questions.some((q) => q.column === "Internal note")).toBe(true);

    const skipped = applyHistoryColumnMap(text, {
      recipient: 0, amounts: [{ index: 1, ticker: "ADA" }], task: 2, date: 3, workgroup: 4, txHash: 5, outputIndex: 6, skip: [7],
    });
    expect(skipped.questions).toEqual([]);
    expect(readHistoryCsv(skipped.csv!, TODAY).rows).toHaveLength(1);
  });
});
