import { describe, expect, it } from "vitest";
import {
  applyWalletTokenHint,
  assetNameFromUnit,
  tokenFromAssetInfo,
} from "./assetInfo";
import type { KoiosAssetInfo } from "./koios";

const UNIT = "a".repeat(56) + "41474958";

function info(partial: Partial<KoiosAssetInfo>): KoiosAssetInfo {
  return {
    policy_id: UNIT.slice(0, 56),
    asset_name: UNIT.slice(56),
    asset_name_ascii: null,
    token_registry_metadata: null,
    cip68_metadata: null,
    ...partial,
  };
}

describe("tokenFromAssetInfo", () => {
  it("prefers CIP-26 registry ticker and decimals", () => {
    const t = tokenFromAssetInfo(
      UNIT,
      100n,
      info({
        asset_name_ascii: "AGIX",
        token_registry_metadata: {
          ticker: "AGIX",
          name: "SingularityNET",
          decimals: 8,
        },
      }),
    );
    expect(t).toEqual({
      unit: UNIT,
      quantity: 100n,
      ticker: "AGIX",
      name: "SingularityNET",
      decimals: 8,
      source: "registry",
    });
  });

  it("falls back to registry name when ticker is missing", () => {
    const t = tokenFromAssetInfo(
      UNIT,
      1n,
      info({ token_registry_metadata: { name: "Token", decimals: 2 } }),
    );
    expect(t.ticker).toBe("Token");
    expect(t.decimals).toBe(2);
    expect(t.source).toBe("registry");
  });

  it("falls back to the ASCII asset name with 0 decimals", () => {
    const t = tokenFromAssetInfo(UNIT, 5n, info({ asset_name_ascii: "AGIX" }));
    expect(t.ticker).toBe("AGIX");
    expect(t.decimals).toBe(0);
    expect(t.source).toBe("ascii");
  });

  it("reads decimals from CIP-68 metadata when the registry has none", () => {
    const t = tokenFromAssetInfo(
      UNIT,
      5n,
      info({
        asset_name_ascii: "AGIX",
        cip68_metadata: { "333": { name: "AGIX", decimals: 6 } },
      }),
    );
    expect(t.decimals).toBe(6);
  });

  it("decodes the asset name from the unit when external metadata is absent", () => {
    const t = tokenFromAssetInfo(UNIT, 7n, undefined);
    expect(t).toEqual({
      unit: UNIT,
      quantity: 7n,
      ticker: "AGIX",
      name: "AGIX",
      decimals: 0,
      source: "ascii",
    });
  });

  it("decodes a printable name after a four-byte CIP-67 label", () => {
    const labelledUnit = "b".repeat(56) + "00000000" + "54455354";
    expect(assetNameFromUnit(labelledUnit)).toBe("TEST");
  });

  it("reads ticker/decimals from the mint tx 721 metadata when unregistered", () => {
    const t = tokenFromAssetInfo(
      UNIT,
      1_000_000n,
      info({
        asset_name_ascii: "AGIX",
        minting_tx_metadata: {
          "721": {
            [UNIT.slice(0, 56)]: {
              AGIX: {
                name: "Agix Community Token",
                ticker: "AGX",
                decimals: 6,
                image: ["ipfs://bafy", "…"],
              },
            },
          },
        },
      }),
    );
    expect(t.ticker).toBe("AGX");
    expect(t.name).toBe("Agix Community Token");
    expect(t.decimals).toBe(6);
    expect(t.source).toBe("mint");
  });

  it("finds the 721 entry by hex asset name (CIP-25 v2 keys)", () => {
    const t = tokenFromAssetInfo(
      UNIT,
      1n,
      info({
        asset_name_ascii: null,
        minting_tx_metadata: {
          "721": {
            [UNIT.slice(0, 56)]: { "41474958": { name: "Badge", decimals: 0 } },
          },
        },
      }),
    );
    expect(t.name).toBe("Badge");
    expect(t.source).toBe("mint");
  });

  it("registry still wins over 721 hints", () => {
    const t = tokenFromAssetInfo(
      UNIT,
      1n,
      info({
        asset_name_ascii: "AGIX",
        token_registry_metadata: { ticker: "AGIX", name: "Registered" },
        minting_tx_metadata: {
          "721": { [UNIT.slice(0, 56)]: { AGIX: { ticker: "NOPE", decimals: 3 } } },
        },
      }),
    );
    expect(t.ticker).toBe("AGIX");
    expect(t.decimals).toBe(3); // registry has none -> hint fills in
    expect(t.source).toBe("registry");
  });

  it("ignores malformed CIP-68 decimals", () => {
    const t = tokenFromAssetInfo(
      UNIT,
      7n,
      info({ cip68_metadata: { "333": { decimals: "six" } } }),
    );
    expect(t.decimals).toBe(0);
  });

  it("fills a newly indexed asset from Treasury Guild's mint record", () => {
    const unresolved = tokenFromAssetInfo(
      UNIT,
      200_000_000_000n,
      info({ asset_name_ascii: "Test Token" }),
    );
    const t = applyWalletTokenHint(unresolved, {
      ticker: "GVTT",
      name: "Test Token",
      decimals: 6,
    });
    expect(t.ticker).toBe("GVTT");
    expect(t.name).toBe("Test Token");
    expect(t.decimals).toBe(6);
    expect(t.source).toBe("mint");
  });

  it("does not override chain registry metadata with a local mint record", () => {
    const registered = tokenFromAssetInfo(
      UNIT,
      100n,
      info({ token_registry_metadata: { ticker: "CHAIN", decimals: 2 } }),
    );
    expect(
      applyWalletTokenHint(registered, {
        ticker: "LOCAL",
        name: "Local token",
        decimals: 6,
      }),
    ).toBe(registered);
  });
});
