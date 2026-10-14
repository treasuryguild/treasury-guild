import { describe, expect, it } from "vitest";
import type { KoiosTxInfo } from "@/lib/cardano/koios";
import {
  isIncomingTx,
  otherOutputAddresses,
  otherOutputAssets,
  otherOutputSum,
  payoutMetaOf,
  treasuryOutputAssets,
  treasuryOutputSum,
} from "./pollRules";

const TREASURY = "addr1treasury";
const POLICY = "d".repeat(56);

function tx(overrides: Partial<KoiosTxInfo>): KoiosTxInfo {
  return {
    tx_hash: "h",
    block_height: 1,
    tx_timestamp: 0,
    inputs: [{ payment_addr: { bech32: "addr1other" }, value: "10" }],
    outputs: [],
    ...overrides,
  };
}

/** An outgoing payout: two recipients plus change, listed out of body order. */
function outgoing(): KoiosTxInfo {
  return tx({
    inputs: [{ payment_addr: { bech32: TREASURY }, value: "100000000" }],
    outputs: [
      {
        payment_addr: { bech32: "addr1bob" },
        value: "1500000",
        tx_index: 1,
        asset_list: [{ policy_id: POLICY, asset_name: "aa", quantity: "2500000" }],
      },
      {
        payment_addr: { bech32: "addr1alice" },
        value: "1500000",
        tx_index: 0,
        asset_list: [{ policy_id: POLICY, asset_name: "aa", quantity: "3500000" }],
      },
      { payment_addr: { bech32: "addr1carol" }, value: "1017160", tx_index: 2 },
      {
        payment_addr: { bech32: TREASURY },
        value: "95000000",
        tx_index: 3,
        asset_list: [{ policy_id: POLICY, asset_name: "aa", quantity: "1000" }],
      },
    ],
    metadata: { "674": { msg: ["hi"] }, "190001": { v: 3, p: [] } },
  });
}

describe("pollRules", () => {
  it("sums only the outputs that land at the treasury", () => {
    const info = tx({
      outputs: [
        { payment_addr: { bech32: TREASURY }, value: "1000000" },
        { payment_addr: { bech32: TREASURY }, value: "500000" },
        { payment_addr: { bech32: "addr1change" }, value: "999" },
      ],
    });
    expect(treasuryOutputSum(info, TREASURY)).toBe(1_500_000n);
  });

  it("sums token quantities per unit and degrades to null without assets", () => {
    const info = tx({
      outputs: [
        {
          payment_addr: { bech32: TREASURY },
          value: "1",
          asset_list: [
            { policy_id: POLICY, asset_name: "aa", quantity: "2" },
            { policy_id: POLICY, asset_name: "aa", quantity: "3" },
            { policy_id: POLICY, asset_name: null, quantity: "1" },
          ],
        },
      ],
    });
    expect(treasuryOutputAssets(info, TREASURY)).toEqual({
      [`${POLICY}aa`]: "5",
      [POLICY]: "1",
    });
    expect(treasuryOutputAssets(tx({ outputs: [] }), TREASURY)).toBeNull();
  });

  it("treats txs spending from the treasury as outgoing", () => {
    expect(isIncomingTx(tx({}), TREASURY)).toBe(true);
    expect(
      isIncomingTx(
        tx({ inputs: [{ payment_addr: { bech32: TREASURY }, value: "1" }] }),
        TREASURY,
      ),
    ).toBe(false);
  });

  it("totals what an outgoing tx paid to other addresses, change excluded", () => {
    const info = outgoing();
    expect(otherOutputSum(info, TREASURY)).toBe(1_500_000n + 1_500_000n + 1_017_160n);
    expect(otherOutputAssets(info, TREASURY)).toEqual({ [`${POLICY}aa`]: "6000000" });
    expect(otherOutputAssets(tx({ outputs: [{ payment_addr: { bech32: "addr1x" }, value: "1" }] }), TREASURY)).toBeNull();
  });

  it("lists recipients in body order using tx_index, not array order", () => {
    expect(otherOutputAddresses(outgoing(), TREASURY)).toEqual(["addr1alice", "addr1bob", "addr1carol"]);
    // Without tx_index the array position stands in; duplicates collapse.
    const info = tx({
      outputs: [
        { payment_addr: { bech32: "addr1bob" }, value: "1" },
        { payment_addr: { bech32: "addr1bob" }, value: "2" },
        { payment_addr: { bech32: TREASURY }, value: "3" },
      ],
    });
    expect(otherOutputAddresses(info, TREASURY)).toEqual(["addr1bob"]);
  });

  it("extracts the payout metadata object only when it is an object", () => {
    expect(payoutMetaOf(outgoing())).toEqual({ v: 3, p: [] });
    expect(payoutMetaOf(tx({}))).toBeNull();
    expect(payoutMetaOf(tx({ metadata: { "190001": "oops" } }))).toBeNull();
    expect(payoutMetaOf(tx({ metadata: { "190001": [1] } }))).toBeNull();
  });
});
