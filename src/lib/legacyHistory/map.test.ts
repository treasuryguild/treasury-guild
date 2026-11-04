import { describe, expect, it } from "vitest";
import { readHistoryCsv } from "./parse";
import { applyHistoryColumnMap, type HistoryColumnMap } from "./map";

const TODAY = "2026-12-31";

const mapped = (overrides: Partial<HistoryColumnMap>): HistoryColumnMap => ({
  recipient: 0, task: 1, date: 2, workgroup: 3, amounts: [{ index: 4, ticker: "ADA" }], skip: [], ...overrides,
});

describe("applyHistoryColumnMap", () => {
  it("rewrites renamed headers into the history CSV and drops a skipped column", () => {
    const text = "Wallet,What,Paid,Team,Note,ADA\nf39ntm,\"Fee, docs\",15.09.2026,ops,ignore,10\n";
    const result = applyHistoryColumnMap(text, mapped({
      recipient: 0, task: 1, date: 2, workgroup: 3, skip: [4], amounts: [{ index: 5, ticker: "ADA" }],
    }));
    expect(result.questions).toEqual([]);
    const parsed = readHistoryCsv(result.csv!, TODAY);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      recipientRef: "f39ntm", task: "Fee, docs", paidOn: "2026-09-15", workgroupName: "ops",
      amounts: [{ ticker: "ADA", raw: "10" }],
    });
  });

  it("asks about a name column and does not invent an address", () => {
    const text = "Name,ADA,task,date,workgroup\nAlice,10,Fee,15.09.2026,ops\n";
    const guessed = applyHistoryColumnMap(text, null);
    expect(guessed.csv).toBeNull();
    expect(guessed.questions.map((q) => q.message).join(" ")).toMatch(/Alice/);
    expect(guessed.questions.map((q) => q.message).join(" ")).toMatch(/address/i);

    const forced = applyHistoryColumnMap(text, mapped({
      recipient: 0, amounts: [{ index: 1, ticker: "ADA" }], task: 2, date: 3, workgroup: 4,
    }));
    expect(forced.csv).toBeNull();
    expect(forced.questions.some((q) => q.message.includes("Alice"))).toBe(true);
    expect(forced.csv ?? "").not.toContain("Alice");
  });

  it("reads a file that is already in the history shape without being told the columns", () => {
    const text = "userId,ADA,task,date,workgroup\nf39ntm,114.5,Fee,15.09.26,governance-workgroup\n";
    const result = applyHistoryColumnMap(text, null);
    expect(result.questions).toEqual([]);
    const parsed = readHistoryCsv(result.csv!, TODAY);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.tickers).toEqual(["ADA"]);
  });

  it("asks which field an extra column is, until it is skipped", () => {
    const text = "userId,ADA,task,date,workgroup,Internal note\nf39ntm,1,Fee,15.09.2026,ops,hello\n";
    const open = applyHistoryColumnMap(text, null);
    expect(open.csv).toBeNull();
    expect(open.questions.some((q) => q.column === "Internal note")).toBe(true);

    const skipped = applyHistoryColumnMap(text, {
      recipient: 0, amounts: [{ index: 1, ticker: "ADA" }], task: 2, date: 3, workgroup: 4, skip: [5],
    });
    expect(skipped.questions).toEqual([]);
    expect(readHistoryCsv(skipped.csv!, TODAY).rows).toHaveLength(1);
  });
});
