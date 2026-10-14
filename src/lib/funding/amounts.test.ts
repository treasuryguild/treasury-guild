import { describe, expect, it } from "vitest";
import { toFundingAmounts } from "./amounts";

const AGIX = "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc53541474958";
const tokens = new Map([["lovelace", { ticker: "ADA", decimals: 6 }], [AGIX, { ticker: "AGIX", decimals: 8 }]]);

describe("toFundingAmounts", () => {
  it("scales display amounts exactly", () => {
    expect(toFundingAmounts([{ unit: AGIX, amount: "211800.72389063" }, { unit: "lovelace", amount: "20000" }], tokens)).toEqual([
      { unit: AGIX, amount: "21180072389063", asset_label: "AGIX", decimals: 8 },
      { unit: "lovelace", amount: "20000000000", asset_label: "ADA", decimals: 6 },
    ]);
  });

  it("refuses unknown tokens, too many decimals and zero", () => {
    expect(() => toFundingAmounts([{ unit: "ab".repeat(30), amount: "1" }], tokens)).toThrow(/Unknown token/);
    expect(() => toFundingAmounts([{ unit: "lovelace", amount: "1.0000001" }], tokens)).toThrow(/decimal places/);
    expect(() => toFundingAmounts([{ unit: "lovelace", amount: "0.0" }], tokens)).toThrow(/above zero/);
  });
});
