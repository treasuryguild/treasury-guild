import { describe, expect, it } from "vitest";
import { asNetwork, explorerAddressUrl, explorerTxUrl, networkName } from "./config";

describe("config", () => {
  it("narrows DB integers to a Network", () => {
    expect(asNetwork(1)).toBe(1);
    expect(asNetwork(0)).toBe(0);
    expect(asNetwork(42)).toBe(0);
  });

  it("names networks", () => {
    expect(networkName(0)).toBe("preprod");
    expect(networkName(1)).toBe("mainnet");
  });

  it("builds explorer links per network", () => {
    expect(explorerTxUrl(0, "abc")).toBe("https://preprod.cexplorer.io/tx/abc");
    expect(explorerTxUrl(1, "abc")).toBe("https://cexplorer.io/tx/abc");
    expect(explorerAddressUrl(0, "addr_test1x")).toBe("https://preprod.cexplorer.io/address/addr_test1x");
    expect(explorerAddressUrl(1, "addr1x")).toBe("https://pool.pm/addr1x");
  });
});
