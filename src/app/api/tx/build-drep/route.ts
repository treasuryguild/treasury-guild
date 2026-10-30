// Builds a DRep register / update / retire transaction for a plain SDK treasury.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildDrepSchema } from "@/lib/api/schemas";
import type { BuildDrepResponse } from "@/lib/api/types";
import { persistGovernanceTx, planDrep } from "@/lib/cardano/governanceBuild";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, buildDrepSchema);
  const plan = await planDrep(body, session.wallet);
  const txRow = await persistGovernanceTx(plan, session.wallet);
  return {
    txId: txRow.id,
    txHash: plan.built!.txHash,
    action: plan.action,
    dRepId: plan.dRepId,
    anchorUrl: plan.anchorUrl,
  } satisfies BuildDrepResponse;
});
