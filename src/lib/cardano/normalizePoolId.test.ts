import { describe, expect, it } from "vitest";
import { normalizePoolId } from "./normalizePoolId";

describe("normalizePoolId", () => {
  it("accepts pool1 bech32 and 56-char hex", () => {
    expect(normalizePoolId("  pool1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq ")).toBe(
      "pool1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    );
    expect(normalizePoolId("A".repeat(56))).toBe("A".repeat(56));
  });

  it("refuses other shapes", () => {
    expect(() => normalizePoolId("not-a-pool")).toThrow(/Pool id/);
    expect(() => normalizePoolId("a".repeat(55))).toThrow(/Pool id/);
  });
});
