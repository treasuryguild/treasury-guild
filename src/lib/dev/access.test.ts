import { describe, expect, it } from "vitest";
import { isDevWallet } from "./access";

describe("isDevWallet", () => {
  it("allows only wallets on the list, exactly", () => {
    const allow = ["addr1dev", "addr1lead"];
    expect(isDevWallet("addr1dev", allow)).toBe(true);
    expect(isDevWallet("addr1lead", allow)).toBe(true);
    expect(isDevWallet("addr1other", allow)).toBe(false);
    expect(isDevWallet("ADDR1DEV", allow)).toBe(false);
    expect(isDevWallet("addr1de", allow)).toBe(false);
  });

  it("denies when signed out or when the list is empty", () => {
    expect(isDevWallet(null, ["addr1dev"])).toBe(false);
    expect(isDevWallet(undefined, ["addr1dev"])).toBe(false);
    expect(isDevWallet("", ["addr1dev", ""])).toBe(false);
    expect(isDevWallet("addr1dev", [])).toBe(false);
  });
});
