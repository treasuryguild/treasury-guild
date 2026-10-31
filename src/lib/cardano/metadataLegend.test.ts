import { describe, expect, it } from "vitest";
import { buildAnchorMetadata, buildAnchorTestMetadata } from "./anchorMetadata";
import { buildCip25Entry, buildCip25Metadata } from "./mintMetadata";
import { buildPayoutMetadata } from "./metadata";
import { buildPaymentMetadata } from "./paymentMetadata";
import { SignerGroup } from "@/lib/constants";
import { buildTreasuryLabel1854Metadata } from "./cip146Registration";
import {
  ANCHOR_METADATA_LEGEND,
  anchorLegend,
  CIP25_METADATA_LEGEND,
  PAYMENT_METADATA_LEGEND,
  PAYOUT_METADATA_LEGEND,
  payoutOrPaymentLegend,
  REGISTRATION_METADATA_LEGEND,
  registrationLegend,
} from "./metadataLegend";

const ADA = { ticker: "ADA", decimals: 6 };
const HASH = "ab".repeat(32);
const CITATION = { number: 7, contentHash: HASH };

describe("metadata legends", () => {
  it("explain every key a payment record can carry", () => {
    const meta = buildPaymentMetadata("signius", "2026-09", "Workgroup Budget", [
      { outputIndex: 0, transfer: true, amounts: [{ ...ADA, quantity: 188_000_000n }] },
    ]);
    const keys = PAYMENT_METADATA_LEGEND.entries.map((e) => e.key);
    for (const k of Object.keys(meta)) expect(keys, `payment key ${k}`).toContain(k);
  });

  it("explain every key a payout record can carry", () => {
    const meta = buildPayoutMetadata("signius", [
      { outputIndex: 0, taskNumber: 12, workgroupName: "Dev", budgetPeriod: "2026-05", amounts: [{ ...ADA, quantity: 5_000_000n }] },
    ]);
    const keys = PAYOUT_METADATA_LEGEND.entries.map((e) => e.key);
    for (const k of Object.keys(meta)) expect(keys, `payout key ${k}`).toContain(k);
  });

  it("explain every reserved CIP-25 property", () => {
    const entry = buildCip25Entry({
      assetName: "GVT",
      image: "ipfs://Qm",
      mediaType: "image/png",
      description: "d",
      files: [{ name: "f", mediaType: "image/png", src: "ipfs://Qm" }],
      ticker: "GVT",
      decimals: 2,
      url: "https://example.org",
    });
    const keys = CIP25_METADATA_LEGEND.entries.map((e) => e.key);
    for (const k of Object.keys(entry)) expect(keys, `cip25 key ${k}`).toContain(k);
  });

  it("picks the legend from the record's shape", () => {
    expect(payoutOrPaymentLegend({ src: "treasury-guild", t: "payment", o: [] })).toBe(PAYMENT_METADATA_LEGEND);
    expect(payoutOrPaymentLegend({ src: "treasury-guild", v: 3, p: [] })).toBe(PAYOUT_METADATA_LEGEND);
    expect(payoutOrPaymentLegend({ v: 2, p: [{ r: "abc" }] })).toBe(PAYOUT_METADATA_LEGEND);
    expect(payoutOrPaymentLegend(null)).toBeNull();
    expect(payoutOrPaymentLegend({ msg: ["hi"] })).toBeNull();
  });
});

describe("metadata legends, both directions", () => {
  const keysOf = (legend: { entries: readonly { key: string }[] }) => legend.entries.map((e) => e.key);

  it("explain the memo of a payment record that carries one", () => {
    const meta = buildPaymentMetadata("signius", "2026-09", "  Hosting invoice 42  ", [
      { outputIndex: 0, transfer: false, amounts: [{ ...ADA, quantity: 188_000_000n }] },
    ]);
    // The record really has the key this test is about.
    expect(meta.m).toBe("Hosting invoice 42");
    for (const k of Object.keys(meta)) expect(keysOf(PAYMENT_METADATA_LEGEND), `payment key ${k}`).toContain(k);
    expect(PAYMENT_METADATA_LEGEND.entries.find((e) => e.key === "m")?.meaning).toMatch(/memo/i);
    // Without a memo the key is absent, as the legend says.
    const bare = buildPaymentMetadata("signius", "2026-09", "   ", [
      { outputIndex: 0, transfer: false, amounts: [{ ...ADA, quantity: 1_000_000n }] },
    ]);
    expect("m" in bare).toBe(false);
  });

  it("explain the decisions a record cites, absent when nothing is cited", () => {
    const payment = buildPaymentMetadata("signius", "2026-09", null, [
      { outputIndex: 0, transfer: false, amounts: [{ ...ADA, quantity: 1_000_000n }] },
    ], [CITATION]);
    expect(payment.g).toEqual([[7, HASH]]);
    const payout = buildPayoutMetadata("signius", [
      { outputIndex: 0, taskNumber: 12, workgroupName: "Dev", budgetPeriod: "2026-05", amounts: [{ ...ADA, quantity: 5_000_000n }], citations: [CITATION] },
    ]);
    expect(payout.g).toEqual([[7, HASH, [12]]]);
    for (const legend of [PAYMENT_METADATA_LEGEND, PAYOUT_METADATA_LEGEND]) {
      expect(legend.entries.find((e) => e.key === "g")?.meaning).toMatch(/proposal/i);
    }
    const bare = buildPayoutMetadata("signius", [
      { outputIndex: 0, taskNumber: 12, workgroupName: "Dev", budgetPeriod: "2026-05", amounts: [{ ...ADA, quantity: 5_000_000n }] },
    ]);
    expect("g" in bare).toBe(false);
  });

  it("list no payment key the builder cannot write", () => {
    const meta = buildPaymentMetadata("signius", "2026-09", "Hosting", [
      { outputIndex: 1, transfer: true, amounts: [{ ...ADA, quantity: 5_000_000n }] },
      { outputIndex: 0, transfer: false, amounts: [{ ticker: "GVTT", quantity: 3500n, decimals: 0 }] },
    ], [CITATION]);
    expect([...keysOf(PAYMENT_METADATA_LEGEND)].sort()).toEqual(Object.keys(meta).sort());
  });

  it("list no payout key the builder cannot write", () => {
    const meta = buildPayoutMetadata("signius", [
      { outputIndex: 0, taskNumber: 12, workgroupName: "Dev", budgetPeriod: "2026-05", amounts: [{ ...ADA, quantity: 5_000_000n }], citations: [CITATION] },
    ]);
    expect([...keysOf(PAYOUT_METADATA_LEGEND)].sort()).toEqual(Object.keys(meta).sort());
  });

  it("list no CIP-25 property the builder cannot write, beyond the structural placeholders", () => {
    const entry = buildCip25Entry({
      assetName: "GVT",
      image: "ipfs://Qm",
      mediaType: "image/png",
      description: "d",
      files: [{ name: "f", mediaType: "image/png", src: "ipfs://Qm" }],
      ticker: "GVT",
      decimals: 2,
      url: "https://example.org",
    });
    const placeholders = ["<policy id>", "<asset name>", "…"];
    const properties = keysOf(CIP25_METADATA_LEGEND).filter((k) => !placeholders.includes(k));
    expect(properties.sort()).toEqual(Object.keys(entry).sort());
    // The placeholders stand for the two map levels and for NFT traits, which the builder writes too.
    for (const p of placeholders) expect(keysOf(CIP25_METADATA_LEGEND)).toContain(p);
    const record = buildCip25Metadata("ab".repeat(28), [{ assetName: "GVT", image: "ipfs://Qm", attributes: { Rarity: "common" } }]);
    expect(Object.keys(record)).toEqual(["ab".repeat(28)]);
    expect(Object.keys(record["ab".repeat(28)]!)).toEqual(["GVT"]);
    expect(record["ab".repeat(28)]!.GVT).toMatchObject({ Rarity: "common" });
  });

  it("explain every key of an anchor record, both ways, and pick the legend for a real record only", () => {
    const record = buildAnchorMetadata("signius", [
      [4, "proposed", HASH, HASH], [4, "opened", HASH],
      [4, "closed", "passed", HASH, [5, 3, [["yes", 2], ["no", 1]]], ["ipfs", "bafy"]],
    ]);
    expect([...keysOf(ANCHOR_METADATA_LEGEND)].sort()).toEqual(Object.keys(record).sort());
    for (const step of ["proposed", "opened", "closed"]) {
      expect(ANCHOR_METADATA_LEGEND.entries.find((e) => e.key === "a")?.meaning).toContain(`"${step}"`);
    }
    expect(anchorLegend(JSON.parse(JSON.stringify(record)))).toBe(ANCHOR_METADATA_LEGEND);
    expect(anchorLegend(buildAnchorTestMetadata("signius"))).toBeNull();
    expect(anchorLegend(null)).toBeNull();
    // The 190001 picker never mistakes an anchor for a payout or payment.
    expect(payoutOrPaymentLegend(record)).toBeNull();
  });

  it("explain every key of a CIP-0146 registration, both ways, and pick the legend for a real record only", () => {
    const hashA = "a".repeat(56);
    const hashB = "b".repeat(56);
    const stakeA = "1".repeat(56);
    const record = buildTreasuryLabel1854Metadata(
      { name: "Main treasury" },
      [
        {
          key_hash: hashA,
          stake_key_hash: stakeA,
          drep_key_hash: null,
          display_name: "Alice",
          signer_group: SignerGroup.Base,
        },
        {
          key_hash: hashB,
          stake_key_hash: null,
          drep_key_hash: null,
          display_name: "Bob",
          signer_group: SignerGroup.Base,
        },
      ],
      "Wallet for co-signer discovery",
    );
    for (const k of Object.keys(record)) {
      expect(keysOf(REGISTRATION_METADATA_LEGEND), `registration key ${k}`).toContain(k);
    }
    expect([...keysOf(REGISTRATION_METADATA_LEGEND)].sort()).toEqual(
      ["description", "name", "participants", "types"].sort(),
    );
    expect(registrationLegend(JSON.parse(JSON.stringify(record)))).toBe(REGISTRATION_METADATA_LEGEND);
    expect(registrationLegend(null)).toBeNull();
    expect(registrationLegend({ name: "x" })).toBeNull();
    expect(payoutOrPaymentLegend(record)).toBeNull();
  });

  it("name each key once and say something about every one", () => {
    for (const legend of [
      PAYOUT_METADATA_LEGEND,
      PAYMENT_METADATA_LEGEND,
      CIP25_METADATA_LEGEND,
      ANCHOR_METADATA_LEGEND,
      REGISTRATION_METADATA_LEGEND,
    ]) {
      const keys = keysOf(legend);
      expect(new Set(keys).size, legend.title).toBe(keys.length);
      for (const entry of legend.entries) expect(entry.meaning.trim().length, `${legend.title} ${entry.key}`).toBeGreaterThan(10);
    }
  });

  it("pick the payment legend for a real payment record and the payout legend for a real payout", () => {
    const payment = buildPaymentMetadata("signius", "2026-09", "Hosting", [
      { outputIndex: 0, transfer: false, amounts: [{ ...ADA, quantity: 1_000_000n }] },
    ]);
    const payout = buildPayoutMetadata("signius", [
      { outputIndex: 0, taskNumber: 12, workgroupName: "Dev", budgetPeriod: "2026-05", amounts: [{ ...ADA, quantity: 5_000_000n }] },
    ]);
    expect(payoutOrPaymentLegend(payment)).toBe(PAYMENT_METADATA_LEGEND);
    expect(payoutOrPaymentLegend(JSON.parse(JSON.stringify(payout)))).toBe(PAYOUT_METADATA_LEGEND);
    // A payment is recognised by either mark alone; arrays and scalars are no record.
    expect(payoutOrPaymentLegend({ t: "payment" })).toBe(PAYMENT_METADATA_LEGEND);
    expect(payoutOrPaymentLegend({ o: [] })).toBe(PAYMENT_METADATA_LEGEND);
    expect(payoutOrPaymentLegend({ t: "payout", o: "x" })).toBeNull();
    expect(payoutOrPaymentLegend([{ p: [] }])).toBeNull();
    expect(payoutOrPaymentLegend("payment")).toBeNull();
  });
});
