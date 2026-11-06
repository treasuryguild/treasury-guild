import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { LegacyIssueCode as Code } from "@/lib/constants";
import { canonicalRow } from "./plan";
import type { LegacyImportPlan, PlannedRow } from "./types";

const HASH = "ab".repeat(32);
const WALLET = "addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const RECIPIENT = "addr_test1rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr";
const SUFFIX = RECIPIENT.slice(-8);

const txInfoBulk = vi.fn();
vi.mock("@/lib/cardano/koios", () => ({ txInfoBulk: (...args: unknown[]) => txInfoBulk(...args) }));

function sha256Hex(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function plannedRow(overrides: Partial<PlannedRow> = {}): PlannedRow {
  return {
    line: 2,
    recipientRef: SUFFIX,
    task: "Fee",
    paidOn: "2024-01-01",
    budgetMonth: "2024-01-01",
    workgroupRef: "ops",
    workgroupId: "w1",
    txHash: HASH,
    outputIndex: 0,
    amounts: [{ ticker: "ADA", raw: "1", unit: "lovelace", decimals: 6, quantity: "1000000" }],
    dedupeKey: "pending",
    status: "new",
    duplicateOfLine: null,
    ...overrides,
  };
}

function planOf(row: PlannedRow): LegacyImportPlan {
  return {
    tickers: [{ ticker: "ADA", status: "resolved", unit: "lovelace", decimals: 6, source: "ada" }],
    workgroups: [{ ref: "ops", name: "ops", status: "resolved", workgroup: { id: "w1", name: "Ops", archived: false } }],
    rows: [row],
    issues: [],
    counts: { lines: 1, new: 1, duplicates: 0, fileDuplicates: 0, invalid: 0 },
    totals: [],
    ready: true,
  };
}

describe("applyPaymentChainChecks", () => {
  beforeEach(() => {
    txInfoBulk.mockReset();
    txInfoBulk.mockResolvedValue([{
      tx_hash: HASH,
      tx_timestamp: 1_704_067_200,
      inputs: [{ payment_addr: { bech32: WALLET } }],
      outputs: [{
        payment_addr: { bech32: RECIPIENT },
        value: "2000000",
        tx_index: 0,
        asset_list: [],
      }],
    }]);
  });

  it("expands a userId suffix to the full output address and recomputes dedupe against existing keys", async () => {
    const { applyPaymentChainChecks } = await import("./verifyChain");
    const fullKey = sha256Hex(canonicalRow({
      recipientRef: RECIPIENT,
      workgroupRef: "ops",
      paidOn: "2024-01-01",
      task: "Fee",
      txHash: HASH,
      outputIndex: 0,
      amounts: [{ unit: "lovelace", quantity: "1000000" }],
    }));
    const result = await applyPaymentChainChecks(planOf(plannedRow()), {
      network: 0,
      previousWalletAddress: WALLET,
      alreadyClaimed: new Map(),
      includeDuplicates: false,
      existingKeys: new Set([fullKey]),
      hash: sha256Hex,
    });
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.rows[0]!.recipientRef).toBe(RECIPIENT);
    expect(result.rows[0]!.dedupeKey).toBe(fullKey);
    expect(result.rows[0]!.status).toBe("duplicate");
    expect(result.ready).toBe(false);
  });

  it("marks a wrong suffix invalid", async () => {
    const { applyPaymentChainChecks } = await import("./verifyChain");
    const result = await applyPaymentChainChecks(planOf(plannedRow({ recipientRef: "zzzzzz" })), {
      network: 0,
      previousWalletAddress: WALLET,
      alreadyClaimed: new Map(),
      includeDuplicates: false,
      existingKeys: new Set(),
      hash: sha256Hex,
    });
    expect(result.rows[0]!.status).toBe("invalid");
    expect(result.issues.some((i) => i.code === Code.RecipientMismatch)).toBe(true);
    expect(result.ready).toBe(false);
  });
});
