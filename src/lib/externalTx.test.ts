import { describe, expect, it } from "vitest";
import type { ExternalTxRow, TransactionSummary } from "@/lib/db/types";
import { parsePayoutMeta } from "@/lib/cardano/metadata";
import { describeExternalTx, recentTreasuryActivity } from "./externalTx";

const META = {
  v: 3,
  src: "treasury-guild",
  c: "signius",
  w: ["[LIVE] Signius Payout Runs"],
  b: ["2026-09"],
  k: ["GVTT", "ADA"],
  p: [
    [0, [[50, 0, 0, ["1"]], [51, 0, 0, ["2.5", "1.5"]]]],
    [1, [[51, 0, 0, ["2.5", "1.5"]]]],
    [2, [[52, 0, 0, ["", "0.5"]]]],
  ],
};

function external(overrides: Partial<ExternalTxRow> = {}): ExternalTxRow {
  return {
    tx_hash: "e".repeat(64),
    treasury_id: "t1",
    block_height: 10,
    block_time: "2026-09-15T18:04:00.000Z",
    fee_lovelace: "206509",
    amount_lovelace: "4017160",
    assets: null,
    to_addresses: ["addr1a", "addr1b", "addr1c"],
    payout_meta: null,
    to_treasury_id: null,
    import_status: null,
    import_issues: [],
    governance_alerted_at: null,
    created_at: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function app(created_at: string): TransactionSummary {
  return {
    id: created_at,
    treasury_id: "t1",
    kind: "payout",
    spending_path: "base",
    description: null,
    signed_addresses: [],
    state: 2,
    tx_hash: null,
    created_at,
  };
}

describe("parsePayoutMeta", () => {
  it("reads workgroups, distinct task numbers and output count from v3 metadata", () => {
    expect(parsePayoutMeta(META)).toEqual({
      workgroups: ["[LIVE] Signius Payout Runs"],
      taskNumbers: [50, 51, 52],
      outputs: 3,
    });
  });

  it("rejects anything that is not a Treasury Guild payout object", () => {
    expect(parsePayoutMeta(null)).toBeNull();
    expect(parsePayoutMeta("x")).toBeNull();
    expect(parsePayoutMeta([1])).toBeNull();
    expect(parsePayoutMeta({ src: "other", p: [] })).toBeNull();
    expect(parsePayoutMeta({ src: "treasury-guild" })).toBeNull();
    // Malformed entries are skipped, not thrown on.
    expect(parsePayoutMeta({ src: "treasury-guild", w: "nope", p: [1, [0, "x"], [0, [["a"]]]] })).toEqual({
      workgroups: [],
      taskNumbers: [],
      outputs: 3,
    });
  });
});

describe("describeExternalTx", () => {
  it("names the payout when metadata is present", () => {
    expect(describeExternalTx(external({ payout_meta: META }))).toEqual({
      title: "Payout on-chain: 3 tasks, 3 outputs",
      detail: "[LIVE] Signius Payout Runs",
    });
  });

  it("falls back to a plain transfer", () => {
    expect(describeExternalTx(external())).toEqual({
      title: "Outgoing transfer",
      detail: "to 3 addresses",
    });
    expect(describeExternalTx(external({ to_addresses: ["addr1a"] })).detail).toBe("to 1 address");
  });
});

describe("recentTreasuryActivity", () => {
  it("interleaves app and external entries newest first and caps the list", () => {
    const list = recentTreasuryActivity(
      [app("2026-09-16T09:00:00.000Z"), app("2026-09-01T00:00:00.000Z")],
      [external(), external({ tx_hash: "f".repeat(64), block_time: "2026-09-15T18:43:00.000Z" })],
      3,
    );
    expect(list.map((i) => `${i.kind}:${i.at}`)).toEqual([
      "app:2026-09-16T09:00:00.000Z",
      "external:2026-09-15T18:43:00.000Z",
      "external:2026-09-15T18:04:00.000Z",
    ]);
  });
});
