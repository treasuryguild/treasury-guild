// Stake address and optional DRep key hash from the connected CIP-30 wallet.
// The same two calls Mesh Multisig makes when a wallet connects: reward
// addresses, then getDRep on the 1.9 IWallet (react 2.0's wallet lacks it).
import type { IWallet } from "@meshsdk/core";

export interface ConnectedSignerKeys {
  stakeAddress: string;
  /** Empty when the wallet has no getDRep or the call fails. */
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
