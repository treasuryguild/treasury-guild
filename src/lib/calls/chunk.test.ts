import { describe, expect, it } from "vitest";
import { chunkSizes } from "./chunk";

describe("chunkSizes", () => {
  it("keeps a small call in one task", () => {
    expect(chunkSizes(0, 20)).toEqual([]);
    expect(chunkSizes(1, 20)).toEqual([1]);
    expect(chunkSizes(20, 20)).toEqual([20]);
  });

  it("balances instead of leaving a tiny last task", () => {
    expect(chunkSizes(21, 20)).toEqual([11, 10]);
    expect(chunkSizes(41, 20)).toEqual([14, 14, 13]);
    expect(chunkSizes(45, 20)).toEqual([15, 15, 15]);
  });

  it("never exceeds the cap and never loses anyone", () => {
    for (let count = 1; count <= 130; count++) {
      const sizes = chunkSizes(count, 20);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(count);
    }
  });
});
