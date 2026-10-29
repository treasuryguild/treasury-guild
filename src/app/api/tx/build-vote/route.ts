// Builds an on-chain governance vote as the treasury's script DRep.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildVoteSchema } from "@/lib/api/schemas";
import type { BuildVoteResponse } from "@/lib/api/types";
import { fetchDrepStatus } from "@/lib/cardano/koios";
import { getProvider } from "@/lib/cardano/provider";
import { requireSdkVote } from "@/lib/cardano/sdkTreasury";
import { buildVoteTx, pinVoteRationale } from "@/lib/cardano/voteBuilder";
import { SpendingPath, TxKind } from "@/lib/constants";
import { assertNoPendingTx, withTransactionRow } from "@/lib/db/transactions";
import { assertTreasuryActive } from "@/lib/db/treasuries";
import { BadRequestError, errorMessage } from "@/lib/errors";
import { voteDescription } from "@/lib/txDescription";
import { loadBuildContext, requirePathBuilder, resolveSpendingPath } from "@/lib/tx";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, buildVoteSchema);
  const { treasuryId, votes } = body;
  const ctx = await loadBuildContext(treasuryId, session.wallet);
  assertTreasuryActive(ctx.treasury);
  const path = resolveSpendingPath(ctx, body.path, TxKind.Vote);
  if (path !== SpendingPath.Base) {
    throw new BadRequestError("Votes use the base spending path only");
  }
  requirePathBuilder(ctx, path, "Only treasury signers can build a vote transaction");
  await assertNoPendingTx(treasuryId);

  const sdk = requireSdkVote(ctx.treasury, ctx.signers);
  const status = await fetchDrepStatus(ctx.network, sdk.dRepId);
  if (!status.active) {
    throw new BadRequestError("Register as a DRep before casting on-chain votes");
  }

  let rationale: { anchorUrl: string; anchorDataHash: string } | null = null;
  if (body.rationaleJson) {
    try {
      rationale = await pinVoteRationale(body.rationaleJson);
    } catch (err) {
      throw new BadRequestError(errorMessage(err));
    }
  }

  let built;
  try {
    built = await buildVoteTx({
      treasuryAddress: sdk.address,
      paymentScriptCbor: sdk.paymentScriptCbor,
      drepScriptCbor: sdk.drepScriptCbor,
      dRepId: sdk.dRepId,
      network: ctx.network,
      provider: getProvider(ctx.network),
      votes,
      rationale,
    });
  } catch (err) {
    throw new BadRequestError(errorMessage(err));
  }

  const txRow = await withTransactionRow(
    {
      treasury_id: treasuryId,
      kind: TxKind.Vote,
      spending_path: path,
      tx_cbor: built.unsignedTxHex,
      tx_hash: built.txHash,
      description: voteDescription(votes.length, sdk.dRepId),
      created_by: session.wallet,
      governance_action: {
        kind: "vote",
        dRepId: sdk.dRepId,
        votes: votes.map((v) => ({
          txHash: v.txHash,
          certIndex: v.certIndex,
          voteKind: v.voteKind,
        })),
      },
    },
    async (tx) => tx,
  );

  return {
    txId: txRow.id,
    txHash: built.txHash,
    dRepId: sdk.dRepId,
    votes: votes.length,
  } satisfies BuildVoteResponse;
});
