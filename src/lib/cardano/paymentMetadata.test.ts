import { describe, expect, it } from "vitest";
import { parsePayoutMeta } from "./metadata";
import { MAX_METADATUM_STR_BYTES, byteLength } from "./metadata";
import {
  MAX_PAYMENT_METADATA_JSON_BYTES,
  assertPaymentMetadataFits,
  buildPaymentMetadata,
  parsePaymentMeta,
  parsePaymentMetadata,
  paymentMetadataJsonBytes,
  type PaymentOutputForMetadata,
} from "./paymentMetadata";

const ADA = { ticker: "ADA", decimals: 6 };
const GVTT = { ticker: "GVTT", decimals: 6 };
const HASH = "ab".repeat(32);

function output(outputIndex: number, transfer: boolean, amounts: PaymentOutputForMetadata["amounts"]): PaymentOutputForMetadata {
  return { outputIndex, transfer, amounts };
}

describe("buildPaymentMetadata", () => {
  it("interns tickers, aligns amounts to them and flags transfers", () => {
    const meta = buildPaymentMetadata("signius", "2026-09", "Design invoice #12", [
      output(1, true, [{ ...ADA, quantity: 2_000_000n }]),
      output(0, false, [{ ...ADA, quantity: 5_000_000n }, { ...GVTT, quantity: 1_500_000n }]),
      output(2, false, [{ ...GVTT, quantity: 250_000n }, { ...ADA, quantity: 0n }]),
    ]);
    expect(meta).toEqual({
      v: 1, src: "guild-vault", t: "payment", c: "signius", b: "2026-09", k: ["ADA", "GVTT"], m: "Design invoice #12",
      o: [[0, ["5", "1.5"], 0], [1, ["2"], 1], [2, ["", "0.25"], 0]],
    });
  });

  it("cites the decisions behind it once each, by number, and omits g when there are none", () => {
    const outputs = [output(0, false, [{ ...ADA, quantity: 1n }])];
    const meta = buildPaymentMetadata("signius", "2026-09", null, outputs, [
      { number: 9, contentHash: HASH }, { number: 3, contentHash: "cd".repeat(32) }, { number: 9, contentHash: "ef".repeat(32) },
    ]);
    expect(meta.g).toEqual([[3, "cd".repeat(32)], [9, HASH]]);
    expect("g" in buildPaymentMetadata("signius", "2026-09", null, outputs)).toBe(false);
    expect("g" in buildPaymentMetadata("signius", "2026-09", null, outputs, [])).toBe(false);
  });

  it("drops the period when every output is a transfer and omits an empty memo", () => {
    const meta = buildPaymentMetadata("signius", "2026-Q3", "   ", [
      output(0, true, [{ ...ADA, quantity: 1n }]),
    ]);
    expect(meta.b).toBe("");
    expect("m" in meta).toBe(false);
    expect(buildPaymentMetadata("signius", "2026-Q3", null, [output(0, false, [{ ...ADA, quantity: 1n }])]).b).toBe("2026-Q3");
  });

  it("keeps every string within the metadatum cap", () => {
    const meta = buildPaymentMetadata("s".repeat(100), "2026-09", "m".repeat(100), [
      output(0, false, [{ ticker: "t".repeat(100), decimals: 0, quantity: 1n }]),
    ]);
    expect(byteLength(meta.c)).toBe(MAX_METADATUM_STR_BYTES);
    expect(byteLength(meta.m!)).toBe(MAX_METADATUM_STR_BYTES);
    expect(byteLength(meta.k[0]!)).toBe(32);
  });

  it("refuses a record too large for one transaction", () => {
    const many = Array.from({ length: 500 }, (_, i) => output(i, false, [{ ...ADA, quantity: 123_456_789n }]));
    const meta = buildPaymentMetadata("signius", "2026-09", null, many);
    expect(paymentMetadataJsonBytes(meta)).toBeGreaterThan(MAX_PAYMENT_METADATA_JSON_BYTES);
    expect(() => assertPaymentMetadataFits(meta)).toThrow(/split it into smaller payments/);
    expect(() => assertPaymentMetadataFits(buildPaymentMetadata("signius", "2026-09", null, many.slice(0, 40)))).not.toThrow();
  });
});

describe("parsePaymentMeta", () => {
  it("round-trips a built record and is never mistaken for a task payout", () => {
    const meta = buildPaymentMetadata("signius", "2026-09", "Memo", [
      output(0, false, [{ ...ADA, quantity: 5_000_000n }, { ...GVTT, quantity: 1_500_000n }]),
      output(1, true, [{ ...GVTT, quantity: 7n }]),
    ]);
    const view = parsePaymentMeta(JSON.parse(JSON.stringify(meta)));
    expect(view).toEqual({
      period: "2026-09", memo: "Memo", tickers: ["ADA", "GVTT"],
      outputs: [
        { outputIndex: 0, transfer: false, amounts: [{ ticker: "ADA", amount: "5" }, { ticker: "GVTT", amount: "1.5" }] },
        { outputIndex: 1, transfer: true, amounts: [{ ticker: "GVTT", amount: "0.000007" }] },
      ],
      citations: [],
    });
    expect(parsePayoutMeta(meta)).toBeNull();
  });

  it("reads the cited decisions, skipping malformed ones", () => {
    const view = parsePaymentMeta({ src: "guild-vault", t: "payment", o: [], g: [[4, HASH], [0, HASH], [5, "nope"], "junk"] });
    expect(view?.citations).toEqual([{ number: 4, contentHash: HASH }]);
  });

  it("rejects payouts and foreign shapes", () => {
    expect(parsePaymentMeta({ v: 3, src: "guild-vault", c: "x", w: [], b: [], k: [], p: [] })).toBeNull();
    expect(parsePaymentMeta({ src: "other", t: "payment", o: [] })).toBeNull();
    expect(parsePaymentMeta(null)).toBeNull();
    expect(parsePaymentMeta([1, 2])).toBeNull();
    expect(parsePaymentMeta("payment")).toBeNull();
  });

  it("skips malformed entries and tolerates missing lists", () => {
    const view = parsePaymentMeta({ src: "guild-vault", t: "payment", o: [[2, ["1", ""], 0], "junk", [0, "x"], [1, ["3"]]] });
    expect(view).toEqual({
      period: "", memo: null, tickers: [],
      outputs: [
        { outputIndex: 1, transfer: false, amounts: [{ ticker: "#0", amount: "3" }] },
        { outputIndex: 2, transfer: false, amounts: [{ ticker: "#0", amount: "1" }] },
      ],
      citations: [],
    });
  });
});

describe("parsePaymentMetadata", () => {
  const record = buildPaymentMetadata("signius", "2026-09", "Hosting", [
    { outputIndex: 0, transfer: false, amounts: [{ ticker: "ADA", quantity: 5_000_000n, decimals: 6 }] },
    { outputIndex: 1, transfer: true, amounts: [{ ticker: "GVTT", quantity: 1000n, decimals: 2 }] },
  ], [{ number: 2, contentHash: HASH }]);

  it("reads back exactly what the builder writes, citations included", () => {
    expect(record.g).toEqual([[2, HASH]]);
    expect(parsePaymentMetadata(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const uncited = Object.fromEntries(Object.entries(record).filter(([k]) => k !== "g"));
    expect(parsePaymentMetadata(uncited)).toEqual(uncited);
  });

  it("is null when a citation is malformed", () => {
    expect(parsePaymentMetadata({ ...record, g: [[2, "short"]] })).toBeNull();
    expect(parsePaymentMetadata({ ...record, g: [[0, HASH]] })).toBeNull();
    expect(parsePaymentMetadata({ ...record, g: [[2, HASH, [1]]] })).toBeNull();
    expect(parsePaymentMetadata({ ...record, g: "none" })).toBeNull();
  });

  it("is null when any part is malformed, where the display reader would show the rest", () => {
    const broken = { ...record, o: [...record.o, [2, ["1"], 5]] };
    expect(parsePaymentMetadata(broken)).toBeNull();
    expect(parsePaymentMeta(broken)?.outputs).toHaveLength(3);
    expect(parsePaymentMetadata({ ...record, v: 2 })).toBeNull();
    expect(parsePaymentMetadata({ ...record, t: "payout" })).toBeNull();
    expect(parsePaymentMetadata({ ...record, o: [[0, ["1", "2", "3"], 0]] })).toBeNull();
  });
});
