// Stake address and optional DRep key hash from the connected CIP-30 wallet.
// Reward addresses are base CIP-30; getDRep needs CIP-95 on the 1.9 IWallet
// (MeshBridge + useMeshWallet request it; react 2.0's wallet lacks getDRep).
// Empty drepKeyHash usually means the wallet never granted CIP-95 for this
// site (disconnect the dApp in the wallet and reconnect).
import type { IWallet } from "@meshsdk/core";

export interface ConnectedSignerKeys {
  stakeAddress: string;
  /** Empty when CIP-95 was not granted or getDRep failed — not that we skipped the call. */
  drepKeyHash: string;
}

export async function readConnectedSignerKeys(wallet: IWallet): Promise<ConnectedSignerKeys> {
  let stakeAddress = "";
  try {
    const rewards = await wallet.getRewardAddresses();
    stakeAddress = rewards[0] ?? "";
  } catch {
    stakeAddress = "";
  }

  let drepKeyHash = "";
  try {
    const withDrep = wallet as IWallet & {
      getDRep?: () => Promise<{ publicKeyHash?: string } | undefined>;
    };
    if (typeof withDrep.getDRep === "function") {
      const drep = await withDrep.getDRep();
      drepKeyHash = drep?.publicKeyHash ?? "";
    }
  } catch {
    drepKeyHash = "";
  }

  return { stakeAddress, drepKeyHash };
}
