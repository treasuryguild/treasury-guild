// Capability gates for Multisig-style SDK treasuries: staking and Cardano
// DRep/voting. Only a plain treasury with a complete role-2 stake-key set
// qualifies; clawback / lock-until / cosigner and legacy enterprise wallets
// stay spend-only. Client-safe (the treasury UI mirrors the build routes).

import { TreasuryTemplate } from "@/lib/constants";
import type { TreasuryRow } from "@/lib/db/types";
import type { MultisigWallet } from "./multisigSDK";

export type CapabilityTreasury = Pick<TreasuryRow, "template">;

/** Plain template + matching stake keys for every base payment key. */
export function isSdkTreasury(treasury: CapabilityTreasury, wallet: MultisigWallet): boolean {
  return treasury.template === TreasuryTemplate.Plain && wallet.stakingEnabled();
}

/** Pool stake / withdrawals / vote-delegation: needs a controllable stake script. */
export function canStake(treasury: CapabilityTreasury, wallet: MultisigWallet): boolean {
  if (!isSdkTreasury(treasury, wallet)) return false;
  return Boolean(wallet.getStakingScript() && wallet.getStakeAddress());
}

/**
 * Register/update/retire as a DRep, or vote: SDK treasury only; DRep script is
 * role-3 when complete, else the payment script (Multisig fallback).
 */
export function canDrep(treasury: CapabilityTreasury, wallet: MultisigWallet): boolean {
  if (!isSdkTreasury(treasury, wallet)) return false;
  return Boolean(wallet.getDRepScript() && wallet.getDRepId());
}

/** On-chain governance votes use the same DRep witness as DRep certificates. */
export function canVote(treasury: CapabilityTreasury, wallet: MultisigWallet): boolean {
  return canDrep(treasury, wallet);
}
