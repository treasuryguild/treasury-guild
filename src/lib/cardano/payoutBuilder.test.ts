import { describe, expect, it } from "vitest";
import type { UTxO } from "@meshsdk/common";
import { ANCHOR_METADATA_LABEL, buildAnchorMetadata, type AnchorEntry } from "./anchorMetadata";
import { MAX_METADATA_JSON_BYTES, metadataJsonBytes } from "./metadata";
import { attachAnchors, sumUtxoAssets } from "./payoutBuilder";

const GVTT = `${"a".repeat(56)}47565454`;
const utxo = (amount: { unit: string; quantity: string }[]): UTxO => ({
  input: { txHash: "a".repeat(64), outputIndex: 0 },
  output: { address: "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5", amount },
});

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("attachAnchors", () => {
  const due = (n: number): { entry: AnchorEntry; n: number } => ({ n, entry: [n, "proposed", H1, H2] });

  it("attaches nothing when no anchor is due", () => {
    expect(attachAnchors("guild", { v: 3 }, undefined)).toEqual({ metadata: [], carried: [] });
    expect(attachAnchors("guild", { v: 3 }, [])).toEqual({ metadata: [], carried: [] });
  });

  it("carries the due anchors under label 190002 beside a small record", () => {
    const entries = [due(1), due(2)];
    const attached = attachAnchors("guild", { v: 3 }, entries);
    expect(attached.carried).toEqual(entries);
    expect(attached.metadata).toEqual([[ANCHOR_METADATA_LABEL, buildAnchorMetadata("guild", entries.map((e) => e.entry))]]);
    expect(ANCHOR_METADATA_LABEL).toBe("190002");
  });

  it("gives the record priority: only what fits in the room it leaves rides along", () => {
    const entries = [due(1), due(2), due(3)];
    const two = metadataJsonBytes(buildAnchorMetadata("guild", [entries[0]!.entry, entries[1]!.entry]));
    const filler = (bytes: number) => ({ m: "x".repeat(bytes - metadataJsonBytes({ m: "" })) });
    const some = attachAnchors("guild", filler(MAX_METADATA_JSON_BYTES - two), entries);
    expect(some.carried.map((c) => c.n)).toEqual([1, 2]);
    expect(attachAnchors("guild", filler(MAX_METADATA_JSON_BYTES - 10), entries)).toEqual({ metadata: [], carried: [] });
  });
});

describe("sumUtxoAssets", () => {
  it("folds every unit across the wallet's UTxOs", () => {
    expect(sumUtxoAssets([
      utxo([{ unit: "lovelace", quantity: "5" }, { unit: GVTT, quantity: "3" }]),
      utxo([{ unit: "lovelace", quantity: "7" }, { unit: GVTT, quantity: "1" }]),
    ])).toEqual(new Map([["lovelace", 12n], [GVTT, 4n]]));
    expect(sumUtxoAssets([])).toEqual(new Map());
  });
});
