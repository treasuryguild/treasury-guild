import { describe, expect, it } from "vitest";
import { MAX_METADATA_JSON_BYTES, metadataJsonBytes } from "./metadata";
import {
  anchorProposalNumbers, buildAnchorMetadata, buildAnchorTestMetadata, compareAnchorEntries, fitAnchorEntries,
  isAnchorEntry, isAnchorRecord, parseAnchorMetadata, type AnchorEntry,
} from "./anchorMetadata";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

const proposed: AnchorEntry = [4, "proposed", H1, H2];
const opened: AnchorEntry = [4, "opened", H3];
const closed: AnchorEntry = [4, "closed", "passed", H3, [5, 3, [["yes", 2], ["no", 1]]], ["ipfs", CID]];

describe("anchor record", () => {
  it("is the exact positional shape", () => {
    expect(buildAnchorMetadata("guild", [proposed, opened, closed])).toEqual({
      v: 1, src: "guild-vault", c: "guild",
      a: [
        [4, "proposed", H1, H2],
        [4, "opened", H3],
        [4, "closed", "passed", H3, [5, 3, [["yes", 2], ["no", 1]]], ["ipfs", CID]],
      ],
    });
  });

  it("round-trips through the strict parser, which refuses the test record and malformed entries", () => {
    const record = buildAnchorMetadata("guild", [proposed, opened, closed, [2, "closed", "withdrawn"]]);
    expect(parseAnchorMetadata(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(parseAnchorMetadata(buildAnchorTestMetadata("guild"))).toBeNull();
    expect(isAnchorRecord(buildAnchorTestMetadata("guild"))).toBe(true);
    expect(parseAnchorMetadata({ ...record, v: 2 })).toBeNull();
    expect(parseAnchorMetadata({ ...record, src: "other" })).toBeNull();
    expect(parseAnchorMetadata({ ...record, a: [[4, "proposed", H1]] })).toBeNull();
    expect(parseAnchorMetadata({ ...record, a: [[4, "opened", "nothex"]] })).toBeNull();
    expect(parseAnchorMetadata({ ...record, a: [[0, "closed", "passed"]] })).toBeNull();
    expect(parseAnchorMetadata({ ...record, a: [[4, "closed", "passed", H3]] })).toBeNull();
    expect(parseAnchorMetadata({ ...record, a: [[4, "closed", "passed", H3, [5, 3, [["yes", -1]]]]] })).toBeNull();
    expect(parseAnchorMetadata({ ...record, a: [[4, "closed", "passed", H3, [5, 3, []], ["ipfs"]]] })).toBeNull();
    expect(parseAnchorMetadata({ ...record, a: [[4, "sealed", H1]] })).toBeNull();
    expect(parseAnchorMetadata(null)).toBeNull();
    expect(parseAnchorMetadata([record])).toBeNull();
    expect(isAnchorEntry([4, "closed", "passed", H3, [5, 3, [["agree", 5]]]])).toBe(true);
  });

  it("names each anchored proposal once, ascending", () => {
    const record = buildAnchorMetadata("guild", [[9, "opened", H3], proposed, opened, [2, "closed", "cancelled"]]);
    expect(anchorProposalNumbers(record)).toEqual([2, 4, 9]);
    expect(anchorProposalNumbers({ v: 1, src: "guild-vault", c: "guild", test: 1 })).toEqual([]);
  });

  it("orders entries by proposal number then lifecycle step", () => {
    const sorted = [closed, [2, "opened", H3] as AnchorEntry, proposed, opened, [2, "proposed", H1, H2] as AnchorEntry]
      .sort(compareAnchorEntries);
    expect(sorted.map((e) => `${e[0]}:${e[1]}`)).toEqual(["2:proposed", "2:opened", "4:proposed", "4:opened", "4:closed"]);
  });

  it("keeps every string under the 64-byte metadatum cap", () => {
    const record = buildAnchorMetadata("x".repeat(80), [proposed, closed]);
    const strings: string[] = [];
    JSON.stringify(record, (_k, v) => { if (typeof v === "string") strings.push(v); return v; });
    for (const s of strings) expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(64);
  });
});

describe("fitAnchorEntries", () => {
  const due = (n: number): { entry: AnchorEntry; n: number } => ({ n, entry: [n, "proposed", H1, H2] });

  it("carries entries in order until the room is used up, and reports which", () => {
    const entries = [due(1), due(2), due(3)];
    const all = fitAnchorEntries("guild", entries);
    expect(all?.carried.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(all?.record.a).toHaveLength(3);
    const two = metadataJsonBytes(buildAnchorMetadata("guild", [entries[0]!.entry, entries[1]!.entry]));
    const some = fitAnchorEntries("guild", entries, two);
    expect(some?.carried.map((c) => c.n)).toEqual([1, 2]);
    expect(some?.record.a).toEqual([entries[0]!.entry, entries[1]!.entry]);
    expect(fitAnchorEntries("guild", entries, 10)).toBeNull();
    expect(fitAnchorEntries("guild", [])).toBeNull();
  });

  it("fits forty proposed anchors in a dedicated transaction, as the estimate found", () => {
    const entries = Array.from({ length: 40 }, (_, i) => due(i + 1));
    const fitted = fitAnchorEntries("signius", entries);
    expect(fitted?.carried).toHaveLength(40);
    expect(metadataJsonBytes(fitted!.record)).toBeLessThanOrEqual(MAX_METADATA_JSON_BYTES);
  });
});
