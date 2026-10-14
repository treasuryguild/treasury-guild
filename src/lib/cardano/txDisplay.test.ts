import { describe, expect, it } from "vitest";
import { unitDisplayFromRegistry } from "@/lib/assetRegistry";
import { describeMint, formatTxAsset } from "./txDisplay";
import type { DecodedTxMint } from "./types";

const POLICY = "e".repeat(56);
const NAME_HEX = "475654"; // "GVT"
const UNIT = `${POLICY}${NAME_HEX}`;
const mint: DecodedTxMint = { unit: UNIT, policyId: POLICY, assetNameHex: NAME_HEX, quantity: "1000000" };
const meta721 = {
  [POLICY]: {
    GVT: { name: "Guild Token", ticker: "GVT", decimals: 6, image: "ipfs://cid1", description: ["a", "b"] },
  },
};

describe("formatTxAsset", () => {
  const display = unitDisplayFromRegistry([{ fieldName: "HOSKY", unit: `${"a".repeat(56)}00`, decimals: 0 }]);
  const mintByUnit = new Map([[UNIT, mint]]);

  it("prefers the registry", () => {
    expect(formatTxAsset(`${"a".repeat(56)}00`, "5", display, mintByUnit, meta721)).toBe("5 HOSKY");
    expect(formatTxAsset("lovelace", "1500000", display, mintByUnit, meta721)).toBe("1.5 ADA");
  });

  it("falls back to the tx's own mint metadata, then to a raw label", () => {
    expect(formatTxAsset(UNIT, "1000000", display, mintByUnit, meta721)).toBe("1 GVT");
    // Without 721 metadata the decimals are unknown (0) and the name is the asset name.
    expect(formatTxAsset(UNIT, "1000000", display, mintByUnit, null)).toBe("1,000,000 GVT");
    expect(formatTxAsset(`${"f".repeat(56)}00`, "7", display, mintByUnit, null)).toBe(
      "7 ffffffffffff…",
    );
  });
});

describe("describeMint", () => {
  it("reads name, image, amount and burn flag", () => {
    const d = describeMint(mint, meta721, "gw.example");
    expect(d.name).toBe("Guild Token");
    expect(d.imageUrl).toBe("https://gw.example/ipfs/cid1");
    expect(d.description).toBe("ab");
    expect(d.amount).toBe("1 GVT");
    expect(d.burn).toBe(false);
    expect(describeMint({ ...mint, quantity: "-5" }, null, "gw").burn).toBe(true);
    expect(describeMint({ ...mint, quantity: "-5" }, null, "gw").name).toBe("GVT");
  });
});
