// Resolve an SDK treasury for stake / DRep / vote builds: capabilities +
// script CBORs derived from the stored rows.
import "server-only";

import type { TreasuryRow, TreasurySignerRow } from "@/lib/db/types";
import { BadRequestError } from "@/lib/errors";
import { buildTreasuryWallet, resolveTreasury } from "@/lib/treasury";
import { canDrep, canStake, canVote } from "./sdkCapabilities";

export function requireSdkStake(
  treasury: TreasuryRow,
  signers: TreasurySignerRow[],
): {
  address: string;
  paymentScriptCbor: string;
  stakingScriptCbor: string;
  rewardAddress: string;
} {
  const resolved = resolveTreasury(treasury, signers);
  const { wallet } = buildTreasuryWallet(treasury, signers);
  if (!canStake(treasury, wallet)) {
    throw new BadRequestError(
      "Only a plain SDK treasury (with stake keys for every base signer) can stake. Create a new plain SDK wallet to enable staking.",
    );
  }
  const stakingScriptCbor = wallet.getStakingScript();
  const rewardAddress = wallet.getStakeAddress();
  if (!stakingScriptCbor || !rewardAddress) {
    throw new BadRequestError("This treasury has no controllable stake script");
  }
  return {
    address: resolved.address,
    paymentScriptCbor: resolved.scriptCbor,
    stakingScriptCbor,
    rewardAddress,
  };
}

export function requireSdkDrep(
  treasury: TreasuryRow,
  signers: TreasurySignerRow[],
): {
  address: string;
  paymentScriptCbor: string;
  drepScriptCbor: string;
  dRepId: string;
} {
  const resolved = resolveTreasury(treasury, signers);
  const { wallet } = buildTreasuryWallet(treasury, signers);
  if (!canDrep(treasury, wallet)) {
    throw new BadRequestError(
      "Only a plain SDK treasury can register as a DRep. Create a new plain SDK wallet to enable Cardano governance.",
    );
  }
  const drepScriptCbor = wallet.getDRepScript();
  const dRepId = wallet.getDRepId();
  if (!drepScriptCbor || !dRepId) {
    throw new BadRequestError("This treasury has no DRep script");
  }
  return {
    address: resolved.address,
    paymentScriptCbor: resolved.scriptCbor,
    drepScriptCbor,
    dRepId,
  };
}

export function requireSdkVote(
  treasury: TreasuryRow,
  signers: TreasurySignerRow[],
): ReturnType<typeof requireSdkDrep> {
  const { wallet } = buildTreasuryWallet(treasury, signers);
  if (!canVote(treasury, wallet)) {
    throw new BadRequestError(
      "Only a plain SDK treasury can cast on-chain governance votes. Create a new plain SDK wallet to enable voting.",
    );
  }
  return requireSdkDrep(treasury, signers);
}
