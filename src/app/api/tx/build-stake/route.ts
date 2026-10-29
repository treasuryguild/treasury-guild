// Builds a stake certificate / withdrawal / vote-delegation transaction for
// a plain SDK treasury. Base path only; one pending tx per treasury.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildStakeSchema } from "@/lib/api/schemas";
import type { BuildStakeResponse } from "@/lib/api/types";
import { fetchStakeAccountStatus } from "@/lib/cardano/koios";
import { getProvider } from "@/lib/cardano/provider";
import { requireSdkStake } from "@/lib/cardano/sdkTreasury";
import { buildStakeTx } from "@/lib/cardano/stakeBuilder";
import { SpendingPath, StakeAction, TxKind } from "@/lib/constants";
import { assertNoPendingTx, withTransactionRow } from "@/lib/db/transactions";
import { assertTreasuryActive } from "@/lib/db/treasuries";
import { BadRequestError, errorMessage } from "@/lib/errors";
import { stakeDescription } from "@/lib/txDescription";
import { loadBuildContext, requirePathBuilder, resolveSpendingPath } from "@/lib/tx";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, buildStakeSchema);
  const { treasuryId, action } = body;
  const ctx = await loadBuildContext(treasuryId, session.wallet);
  assertTreasuryActive(ctx.treasury);
  const path = resolveSpendingPath(ctx, body.path, TxKind.Stake);
  if (path !== SpendingPath.Base) {
    throw new BadRequestError("Stake actions use the base spending path only");
  }
  requirePathBuilder(ctx, path, "Only treasury signers can build a stake transaction");
  await assertNoPendingTx(treasuryId);

  const sdk = requireSdkStake(ctx.treasury, ctx.signers);
  const status = await fetchStakeAccountStatus(ctx.network, sdk.rewardAddress);

  if (
    (action === StakeAction.Register || action === StakeAction.RegisterAndDelegate) &&
    status.active
  ) {
    throw new BadRequestError("Stake key is already registered");
  }
  if (
    (action === StakeAction.Delegate ||
      action === StakeAction.Deregister ||
      action === StakeAction.Withdraw ||
      action === StakeAction.VoteDelegation) &&
    !status.active
  ) {
    throw new BadRequestError("Stake key is not registered yet — register first");
  }
  if (action === StakeAction.Withdraw && (!status.rewardsAvailable || status.rewardsAvailable === "0")) {
    throw new BadRequestError("No rewards available to withdraw");
  }

  let built;
  try {
    built = await buildStakeTx({
      treasuryAddress: sdk.address,
      paymentScriptCbor: sdk.paymentScriptCbor,
      stakingScriptCbor: sdk.stakingScriptCbor,
      rewardAddress: sdk.rewardAddress,
      network: ctx.network,
      provider: getProvider(ctx.network),
      action,
      poolId: body.poolId,
      dRepId: body.dRepId,
      rewards: status.rewardsAvailable,
    });
  } catch (err) {
    throw new BadRequestError(errorMessage(err));
  }

  const txRow = await withTransactionRow(
    {
      treasury_id: treasuryId,
      kind: TxKind.Stake,
      spending_path: path,
      tx_cbor: built.unsignedTxHex,
      tx_hash: built.txHash,
      description: stakeDescription(action, { poolId: body.poolId, dRepId: body.dRepId }),
      created_by: session.wallet,
      governance_action: {
        kind: "stake",
        action,
        poolId: body.poolId ?? null,
        dRepId: body.dRepId ?? null,
        rewards: action === StakeAction.Withdraw ? status.rewardsAvailable : null,
      },
    },
    async (tx) => tx,
  );

  return {
    txId: txRow.id,
    txHash: built.txHash,
    action,
    rewardAddress: sdk.rewardAddress,
  } satisfies BuildStakeResponse;
});
