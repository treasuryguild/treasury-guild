import { describe, expect, it } from "vitest";
import { networkMismatchReason, sortByWalletNetwork } from "./networkGate";

describe("networkMismatchReason", () => {
  it("allows a matching wallet and an unknown wallet network", () => {
    expect(networkMismatchReason(0, 0)).toBeNull();
    expect(networkMismatchReason(1, 1)).toBeNull();
    expect(networkMismatchReason(null, 1)).toBeNull();
  });

  it("names both networks when they differ", () => {
    expect(networkMismatchReason(0, 1)).toMatch(/wallet is on preprod.*runs on mainnet.*mainnet account/);
    expect(networkMismatchReason(1, 0)).toMatch(/wallet is on mainnet.*runs on preprod.*preprod account/);
  });
});

describe("sortByWalletNetwork", () => {
  const list = [
    { slug: "a", network: 1 },
    { slug: "b", network: 0 },
    { slug: "c", network: 1 },
    { slug: "d", network: 0 },
  ];

  it("puts the wallet's network first and keeps the original order within each group", () => {
    expect(sortByWalletNetwork(list, 0).map((c) => c.slug)).toEqual(["b", "d", "a", "c"]);
    expect(sortByWalletNetwork(list, 1).map((c) => c.slug)).toEqual(["a", "c", "b", "d"]);
  });

  it("leaves the order alone without a wallet network", () => {
    expect(sortByWalletNetwork(list, null).map((c) => c.slug)).toEqual(["a", "b", "c", "d"]);
  });
});
