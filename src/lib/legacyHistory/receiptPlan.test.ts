import { describe, expect, it } from "vitest";
import { ADA_ASSET } from "@/lib/assets";
import { readReceiptsCsv } from "./receiptParse";
import { canonicalReceiptRow, legacyReceiptRpcRows, planLegacyReceipts } from "./receiptPlan";

const hash = (s: string) => `hash:${s.length}`;

describe("planLegacyReceipts", () => {
  it("resolves a known funding source and builds rpc rows", () => {
    const parsed = readReceiptsCsv(
      `date,ADA,source,commitment,txHash,outputIndex\n15.09.2024,1.5,Catalyst,Fund 10,${"c".repeat(64)},0`,
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
      txHash: "c".repeat(64),
      outputIndex: 0,
      dedupeKey: expect.stringMatching(/^hash:/),
      amounts: [{ unit: ADA_ASSET.unit, ticker: "ADA", decimals: 6, amount: "1500000" }],
    }]);
  });

  it("allows untagged income and marks duplicates", () => {
    const parsed = readReceiptsCsv(`date,ADA,txHash,outputIndex\n15.09.2024,1,${"a".repeat(64)},0\n15.09.2024,1,${"a".repeat(64)},0`, "2026-11-04");
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
    expect(plan.defaultSourceId).toBeNull();
  });

  it("tags blank-source rows with a default funding source and commitment", () => {
    const parsed = readReceiptsCsv(
      `date,ADA,source,txHash,outputIndex\n15.09.2024,1,,${"d".repeat(64)},0\n16.09.2024,2,Catalyst,${"e".repeat(64)},0`,
      "2026-11-04",
    );
    const plan = planLegacyReceipts(parsed, {
      registry: [],
      manual: new Map(),
      history: [],
      wallet: [],
      sources: [{ id: "s1", name: "Catalyst" }, { id: "s2", name: "Other" }],
      commitments: [{ id: "c1", sourceId: "s2", name: "Grant" }],
      defaultSourceId: "s2",
      defaultCommitmentId: "c1",
      existingKeys: new Set(),
      hash,
      includeDuplicates: false,
    });
    expect(plan.ready).toBe(true);
    expect(plan.defaultSourceId).toBe("s2");
    expect(plan.defaultCommitmentId).toBe("c1");
    expect(plan.rows[0]).toMatchObject({ sourceRef: "", sourceId: "s2", commitmentId: "c1" });
    expect(plan.rows[1]).toMatchObject({ sourceRef: "catalyst", sourceId: "s1", commitmentId: null });
    expect(legacyReceiptRpcRows(plan, false).map((r) => r.fundingSourceId)).toEqual(["s2", "s1"]);
  });
});

describe("canonicalReceiptRow", () => {
  it("ignores note spacing and amount order", () => {
    expect(canonicalReceiptRow({
      receivedOn: "2024-01-01",
      sourceRef: "catalyst",
      commitmentRef: "",
      note: "  Hello   world ",
      txHash: "a".repeat(64),
      outputIndex: 0,
      amounts: [{ unit: "b", quantity: "2" }, { unit: "a", quantity: "1" }],
    })).toBe(canonicalReceiptRow({
      receivedOn: "2024-01-01",
      sourceRef: "catalyst",
      commitmentRef: "",
      note: "hello world",
      txHash: "a".repeat(64),
      outputIndex: 0,
      amounts: [{ unit: "a", quantity: "1" }, { unit: "b", quantity: "2" }],
    }));
  });
});
