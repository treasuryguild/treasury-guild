// Builds a stake certificate / withdrawal / vote-delegation transaction for
// a plain SDK treasury. Base path only; one pending tx per treasury.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildStakeSchema } from "@/lib/api/schemas";
import type { BuildStakeResponse } from "@/lib/api/types";
import { persistGovernanceTx, planStake } from "@/lib/cardano/governanceBuild";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, buildStakeSchema);
  const plan = await planStake(body, session.wallet);
  const txRow = await persistGovernanceTx(plan, session.wallet);
  return {
    txId: txRow.id,
    txHash: plan.built.txHash,
    action: plan.action,
    rewardAddress: plan.rewardAddress,
  } satisfies BuildStakeResponse;
});
