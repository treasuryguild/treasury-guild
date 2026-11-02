import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetInfoBulk: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock("@/lib/cardano/koios", () => ({ assetInfoBulk: mocks.assetInfoBulk }));
vi.mock("@/lib/cardano/provider", () => ({ getProvider: mocks.getProvider }));

import { enrichRegistryFromUnits } from "./walletAssets";

const POLICY = "c".repeat(56);
const UNIT = `${POLICY}484f534b59`; // "HOSKY"

beforeEach(() => {
  vi.resetAllMocks();
});

describe("enrichRegistryFromUnits", () => {
  it("skips units already in the registry and lovelace", async () => {
    const registry = [{ fieldName: "HOSKY", unit: UNIT, decimals: 0 }];
    const out = await enrichRegistryFromUnits(0, registry, ["lovelace", UNIT]);
    expect(out).toBe(registry);
    expect(mocks.assetInfoBulk).not.toHaveBeenCalled();
  });

  it("appends described tokens for unknown units", async () => {
    mocks.assetInfoBulk.mockResolvedValue(
      new Map([
        [
          UNIT,
          {
            policy_id: POLICY,
            asset_name: "484f534b59",
            token_registry_metadata: { ticker: "HOSKY", name: "Hosky", decimals: 0 },
            minting_tx_metadata: null,
          },
        ],
      ]),
    );
    const out = await enrichRegistryFromUnits(0, [], [UNIT, UNIT]);
    expect(out).toEqual([{ fieldName: "HOSKY", unit: UNIT, decimals: 0 }]);
    expect(mocks.assetInfoBulk).toHaveBeenCalledWith(0, [UNIT]);
  });

  it("leaves the registry unchanged when Koios fails", async () => {
    const unknown = `${"d".repeat(56)}00`;
    mocks.assetInfoBulk.mockRejectedValue(new Error("koios down"));
    const registry = [{ fieldName: "ADA", unit: "lovelace", decimals: 6 }];
    const out = await enrichRegistryFromUnits(0, registry, [unknown]);
    expect(out).toBe(registry);
    expect(mocks.assetInfoBulk).toHaveBeenCalledWith(0, [unknown]);
  });
});
