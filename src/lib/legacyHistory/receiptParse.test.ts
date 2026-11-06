import { describe, expect, it } from "vitest";
import { LegacyIssueCode } from "@/lib/constants";
import { normalizeFundingName, readReceiptsCsv } from "./receiptParse";

describe("readReceiptsCsv", () => {
  it("parses date, token amounts, optional source/commitment/note", () => {
    const parsed = readReceiptsCsv(
      `date,ADA,source,commitment,note,txHash,outputIndex\n15.09.2024,50000,Project Catalyst,Fund 10,Q3,${"a".repeat(64)},0\n01.10.2024,1000,,,,${"b".repeat(64)},1`,
      "2026-11-04",
    );
    expect(parsed.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(parsed.tickers).toEqual(["ADA"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      receivedOn: "2024-09-15",
      sourceRef: "project catalyst",
      sourceName: "Project Catalyst",
      commitmentRef: "fund 10",
      note: "Q3",
      amounts: [{ ticker: "ADA", raw: "50000" }],
    });
    expect(parsed.rows[1]).toMatchObject({
      receivedOn: "2024-10-01",
      sourceRef: "",
      commitmentRef: "",
      note: null,
    });
  });

  it("refuses a commitment without a source", () => {
    const parsed = readReceiptsCsv(`date,ADA,commitment,txHash,outputIndex\n15.09.2024,1,Fund 10,${"a".repeat(64)},0`, "2026-11-04");
    expect(parsed.rows).toEqual([]);
    expect(parsed.issues.some((i) => i.code === LegacyIssueCode.CommitmentWithoutSource)).toBe(true);
  });

  it("requires a date column and a token column", () => {
    expect(readReceiptsCsv("source,ADA\nCatalyst,1", "2026-11-04").issues.map((i) => i.code))
      .toContain(LegacyIssueCode.MissingColumn);
    expect(readReceiptsCsv("date,source\n15.09.2024,Catalyst", "2026-11-04").issues.map((i) => i.code))
      .toContain(LegacyIssueCode.NoTickerColumns);
  });
});

describe("normalizeFundingName", () => {
  it("collapses case and spaces", () => {
    expect(normalizeFundingName("  Project   Catalyst ")).toBe("project catalyst");
  });
});
