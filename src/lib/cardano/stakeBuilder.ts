// Builds stake registration / delegation / deregistration / withdrawal /
// vote-delegation transactions for an SDK treasury (role-2 stake script).
import "server-only";

import type { IFetcher } from "@meshsdk/common";
import type { MeshTxBuilder } from "@meshsdk/core";

import { StakeAction } from "@/lib/constants";
import type { Network } from "@/lib/config";
import { completeCertTx } from "./certTxBuilder";
import { normalizePoolId } from "./normalizePoolId";

const STAKE_DEPOSIT = 2_000_000n;

export async function buildStakeTx(opts: {
  treasuryAddress: string;
  paymentScriptCbor: string;
  stakingScriptCbor: string;
  rewardAddress: string;
  network: Network;
  provider: IFetcher;
  action: StakeAction;
  poolId?: string | null;
  /** DRep id, or always_abstain / always_no_confidence. */
  dRepId?: string | null;
  /** Available rewards (lovelace string) for withdraw. */
  rewards?: string | null;
}): Promise<{ unsignedTxHex: string; txHash: string }> {
  const {
    rewardAddress,
    stakingScriptCbor,
    action,
    poolId,
    dRepId,
    rewards,
  } = opts;

  const deposit =
    action === StakeAction.Register || action === StakeAction.RegisterAndDelegate
      ? STAKE_DEPOSIT
      : 0n;

  return completeCertTx({
    treasuryAddress: opts.treasuryAddress,
    paymentScriptCbor: opts.paymentScriptCbor,
    network: opts.network,
    provider: opts.provider,
    depositLovelace: deposit,
    apply: (txBuilder) => applyStakeAction(txBuilder, {
      action,
      rewardAddress,
      stakingScriptCbor,
      poolId,
      dRepId,
      rewards,
    }),
  });
}

function applyStakeAction(
  txBuilder: MeshTxBuilder,
  opts: {
    action: StakeAction;
    rewardAddress: string;
    stakingScriptCbor: string;
    poolId?: string | null;
    dRepId?: string | null;
    rewards?: string | null;
  },
): void {
  const { action, rewardAddress, stakingScriptCbor } = opts;
  switch (action) {
    case StakeAction.Register:
      // Prefer register_and_delegate in the UI; bare register can trip
      // ExtraneousScriptWitnessesUTXOW on some Mesh/node combinations.
      txBuilder.registerStakeCertificate(rewardAddress).certificateScript(stakingScriptCbor);
      break;
    case StakeAction.RegisterAndDelegate: {
      const pool = normalizePoolId(opts.poolId ?? "");
      txBuilder.registerStakeCertificate(rewardAddress).certificateScript(stakingScriptCbor);
      txBuilder.delegateStakeCertificate(rewardAddress, pool).certificateScript(stakingScriptCbor);
      break;
    }
    case StakeAction.Delegate:
      txBuilder
        .delegateStakeCertificate(rewardAddress, normalizePoolId(opts.poolId ?? ""))
        .certificateScript(stakingScriptCbor);
      break;
    case StakeAction.Deregister:
      txBuilder.deregisterStakeCertificate(rewardAddress).certificateScript(stakingScriptCbor);
      break;
    case StakeAction.Withdraw: {
      const amount = (opts.rewards ?? "0").trim();
      if (!/^\d+$/.test(amount) || amount === "0") {
        throw new Error("No rewards available to withdraw");
      }
      txBuilder.withdrawal(rewardAddress, amount).withdrawalScript(stakingScriptCbor);
      break;
    }
    case StakeAction.VoteDelegation: {
      const id = (opts.dRepId ?? "").trim();
      const drep =
        id === "always_abstain" || id === "Always Abstain"
          ? { alwaysAbstain: null }
          : id === "always_no_confidence" || id === "Always No Confidence"
            ? { alwaysNoConfidence: null }
            : { dRepId: id };
      txBuilder.voteDelegationCertificate(drep, rewardAddress).certificateScript(stakingScriptCbor);
      break;
    }
    default:
      throw new Error(`Unknown stake action: ${action}`);
  }
}
