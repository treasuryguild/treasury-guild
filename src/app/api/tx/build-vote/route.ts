// Builds an on-chain governance vote as the treasury's script DRep.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildVoteSchema } from "@/lib/api/schemas";
import type { BuildVoteResponse } from "@/lib/api/types";
import { persistGovernanceTx, planVote } from "@/lib/cardano/governanceBuild";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, buildVoteSchema);
  const plan = await planVote(body, session.wallet);
  const txRow = await persistGovernanceTx(plan, session.wallet);
  return {
    txId: txRow.id,
    txHash: plan.built!.txHash,
    dRepId: plan.dRepId,
    votes: plan.votes.length,
  } satisfies BuildVoteResponse;
});
