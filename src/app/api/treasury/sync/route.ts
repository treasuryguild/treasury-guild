import { parseJson, sessionRoute } from "@/lib/api/route";
import { communityIdSchema } from "@/lib/api/schemas";
import type { ChainSyncResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import { syncCommunityIfStale } from "@/lib/reconciliation/staleSync";

/**
 * Called by the Treasury and Incoming pages on visit. Polls the chain for the
 * community's treasuries that were not checked in the last two minutes (see
 * staleSync.ts); a no-op otherwise. Any member may trigger it: the staleness
 * claim, not the caller, bounds the Koios load.
 */
export const POST = sessionRoute(async (req, { session }) => {
  const { communityId } = await parseJson(req, communityIdSchema);
  await requireMember(communityId, session.wallet);
  return (await syncCommunityIfStale(communityId)) satisfies ChainSyncResponse;
});
