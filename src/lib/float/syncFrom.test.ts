import { describe, expect, it } from "vitest";
import type { KoiosTxInfo } from "@/lib/cardano/koios";
import { txTouchesAddress } from "./syncFrom";

const ADDR = "addr_test1float";
const OTHER = "addr_test1other";

function info(patch: Partial<KoiosTxInfo> = {}): KoiosTxInfo {
  return {
    tx_hash: "a".repeat(64),
    block_height: 100,
    tx_timestamp: 1,
    inputs: [{ payment_addr: { bech32: OTHER }, value: "1" }],
    outputs: [{ payment_addr: { bech32: OTHER }, value: "1" }],
    ...patch,
  };
}

describe("txTouchesAddress", () => {
  it("matches an input or output payment address", () => {
    expect(txTouchesAddress(info({
      inputs: [{ payment_addr: { bech32: ADDR }, value: "1" }],
    }), ADDR)).toBe(true);
    expect(txTouchesAddress(info({
      outputs: [{ payment_addr: { bech32: ADDR }, value: "1" }],
    }), ADDR)).toBe(true);
    expect(txTouchesAddress(info(), ADDR)).toBe(false);
  });
});
