// DReps for the Staking page picker and for resolving givenNames on the
// Treasury activity list (Koios drep_list + metadata). Membership is enough:
// the catalog is public chain data and titles must resolve even when the first
// listed wallet is not an SDK treasury.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { drepsQuerySchema } from "@/lib/api/schemas";
import type { DrepsResponse } from "@/lib/api/types";
import { lookupDrep, searchDreps } from "@/lib/cardano/koios";
import { requireMember } from "@/lib/authz";
import { asNetwork } from "@/lib/config";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { loadTreasuryWithSigners } from "@/lib/db/treasuries";

export const GET = sessionRoute(async (req, { session }) => {
  const { treasuryId, q, dRepId, limit } = parseQuery(req, drepsQuerySchema);
  await enforceRateLimit("chainProxy", session.wallet);
  const { treasury } = await loadTreasuryWithSigners(treasuryId);
  await requireMember(treasury.community_id, session.wallet);
  const network = asNetwork(treasury.network);
  if (dRepId) {
    const drep = await lookupDrep(network, dRepId);
    return { dreps: drep ? [drep] : [] } satisfies DrepsResponse;
  }
  const dreps = await searchDreps(network, { q, limit });
  return { dreps } satisfies DrepsResponse;
});
