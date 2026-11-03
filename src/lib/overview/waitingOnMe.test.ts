import { describe, expect, it } from "vitest";
import { SignerGroup, SpendingPath, TreasuryTemplate } from "@/lib/constants";
import { txsWaitingOnMe, type WaitingOnMeTreasury } from "./waitingOnMe";

const treasury: WaitingOnMeTreasury = {
  id: "t1",
  template: TreasuryTemplate.Plain,
  script_type: "atLeast",
  required: 2,
  recovery_script_type: null,
  recovery_required: null,
  lock_until: null,
  cosigner_kind: null,
};

const signers = [
  { treasury_id: "t1", wallet_address: "addr_a", signer_group: SignerGroup.Base },
  { treasury_id: "t1", wallet_address: "addr_b", signer_group: SignerGroup.Base },
  { treasury_id: "t1", wallet_address: "addr_c", signer_group: SignerGroup.Base },
];

function tx(patch: Partial<Parameters<typeof txsWaitingOnMe>[0][number]> = {}) {
  return {
    id: "tx1",
    treasury_id: "t1",
    spending_path: SpendingPath.Base,
    signed_addresses: [] as string[],
    rejected_addresses: [] as string[],
    ...patch,
  };
}

describe("txsWaitingOnMe", () => {
  it("keeps pending txs the wallet has not signed or rejected", () => {
    expect(txsWaitingOnMe([tx()], [treasury], signers, "addr_a")).toEqual([tx()]);
  });

  it("drops txs the wallet already signed or rejected", () => {
    expect(txsWaitingOnMe([tx({ signed_addresses: ["addr_a"] })], [treasury], signers, "addr_a")).toEqual([]);
    expect(txsWaitingOnMe([tx({ rejected_addresses: ["addr_a"] })], [treasury], signers, "addr_a")).toEqual([]);
  });

  it("drops txs whose path does not include the wallet", () => {
    expect(txsWaitingOnMe([tx()], [treasury], signers, "addr_stranger")).toEqual([]);
  });

  it("uses the path's own participants (recovery vs base)", () => {
    const clawback: WaitingOnMeTreasury = {
      ...treasury,
      template: TreasuryTemplate.Clawback,
      recovery_script_type: "any",
      recovery_required: 1,
    };
    const withRecovery = [
      ...signers,
      { treasury_id: "t1", wallet_address: "addr_rec", signer_group: SignerGroup.Recovery },
    ];
    const recoveryTx = tx({ spending_path: SpendingPath.Recovery });
    expect(txsWaitingOnMe([recoveryTx], [clawback], withRecovery, "addr_a")).toEqual([]);
    expect(txsWaitingOnMe([recoveryTx], [clawback], withRecovery, "addr_rec")).toEqual([recoveryTx]);
  });
});
