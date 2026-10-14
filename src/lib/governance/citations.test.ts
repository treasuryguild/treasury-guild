import { describe, expect, it } from "vitest";
import { citationsOf } from "./citations";

const A = "40000000-0000-4000-8000-00000000000a";
const B = "40000000-0000-4000-8000-00000000000b";
const proposals = new Map([
  [A, { number: 4, content_hash: "ab".repeat(32) }],
  [B, { number: 2, content_hash: "cd".repeat(32) }],
]);

describe("citationsOf", () => {
  it("resolves ids to numbered citations, sorted, once each, skipping nulls and unknowns", () => {
    expect(citationsOf([A, null, undefined, "missing", B, A], proposals)).toEqual([
      { number: 2, contentHash: "cd".repeat(32) },
      { number: 4, contentHash: "ab".repeat(32) },
    ]);
  });

  it("is empty when nothing is cited", () => {
    expect(citationsOf([null, undefined], proposals)).toEqual([]);
    expect(citationsOf([], new Map())).toEqual([]);
  });
});
