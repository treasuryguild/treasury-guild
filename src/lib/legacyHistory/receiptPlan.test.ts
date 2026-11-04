import { describe, expect, it } from "vitest";
import { ADA_ASSET } from "@/lib/assets";
import { readReceiptsCsv } from "./receiptParse";
import { canonicalReceiptRow, legacyReceiptRpcRows, planLegacyReceipts } from "./receiptPlan";

const hash = (s: string) => `hash:${s.length}`;

describe("planLegacyReceipts", () => {
  it("resolves a known funding source and builds rpc rows", () => {
    const parsed = readReceiptsCsv(
      "date,ADA,source,commitment\n15.09.2024,1.5,Catalyst,Fund 10",
      "2026-11-04",
    );
    const plan = planLegacyReceipts(parsed, {
      registry: [],
      manual: new Map(),
      history: [],
      wallet: [],
      sources: [{ id: "s1", name: "Catalyst" }],
      commitments: [{ id: "c1", sourceId: "s1", name: "Fund 10" }],
      existingKeys: new Set(),
      hash,
      includeDuplicates: false,
    });
    expect(plan.ready).toBe(true);
    expect(plan.rows[0]?.sourceId).toBe("s1");
    expect(plan.rows[0]?.commitmentId).toBe("c1");
    expect(legacyReceiptRpcRows(plan, false)).toEqual([{
      lineNo: 2,
      receivedOn: "2024-09-15",
      fundingSourceId: "s1",
      fundingCommitmentId: "c1",
      note: null,
      dedupeKey: expect.stringMatching(/^hash:/),
      amounts: [{ unit: ADA_ASSET.unit, ticker: "ADA", decimals: 6, amount: "1500000" }],
    }]);
  });

  it("allows untagged income and marks duplicates", () => {
    const parsed = readReceiptsCsv("date,ADA\n15.09.2024,1\n15.09.2024,1", "2026-11-04");
    const plan = planLegacyReceipts(parsed, {
      registry: [],
      manual: new Map(),
      history: [],
      wallet: [],
      sources: [],
      commitments: [],
      existingKeys: new Set(),
      hash,
      includeDuplicates: false,
    });
    expect(plan.ready).toBe(true);
    expect(plan.rows[0]?.status).toBe("new");
    expect(plan.rows[1]?.duplicateOfLine).toBe(2);
    expect(plan.counts.fileDuplicates).toBe(1);
  });
});

describe("canonicalReceiptRow", () => {
  it("ignores note spacing and amount order", () => {
    expect(canonicalReceiptRow({
      receivedOn: "2024-01-01",
      sourceRef: "catalyst",
      commitmentRef: "",
      note: "  Hello   world ",
      amounts: [{ unit: "b", quantity: "2" }, { unit: "a", quantity: "1" }],
    })).toBe(canonicalReceiptRow({
      receivedOn: "2024-01-01",
      sourceRef: "catalyst",
      commitmentRef: "",
      note: "hello world",
      amounts: [{ unit: "a", quantity: "1" }, { unit: "b", quantity: "2" }],
    }));
  });
});
