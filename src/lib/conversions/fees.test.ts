import { describe, expect, it } from "vitest";
import { sumConversionFees } from "./fees";

describe("sumConversionFees", () => {
  it("sums by asset label and chain with exact decimals", () => {
    expect(sumConversionFees([
      { amount: "0.002", assetLabel: "ETH", chain: "ethereum" },
      { amount: "0.0015", assetLabel: "ETH", chain: "ethereum" },
      { amount: "1.5", assetLabel: "FET", chain: "ethereum" },
      { amount: "0.1", assetLabel: "FET", chain: null },
    ])).toEqual([
      { assetLabel: "ETH", chain: "ethereum", amount: "0.0035" },
      { assetLabel: "FET", chain: null, amount: "0.1" },
      { assetLabel: "FET", chain: "ethereum", amount: "1.5" },
    ]);
  });

  it("returns nothing for an empty list", () => {
    expect(sumConversionFees([])).toEqual([]);
  });
});
