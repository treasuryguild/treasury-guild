// On-chain DRep status for an SDK treasury (Koios).
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { treasuryIdOnlyQuerySchema } from "@/lib/api/schemas";
import type { DrepStatusResponse } from "@/lib/api/types";
import { fetchDrepStatus } from "@/lib/cardano/koios";
import { requireSdkDrep } from "@/lib/cardano/sdkTreasury";
import { requireMember } from "@/lib/authz";
import { loadTreasuryWithSigners } from "@/lib/db/treasuries";
import { asNetwork } from "@/lib/config";

export const GET = sessionRoute(async (req, { session }) => {
  const { treasuryId } = parseQuery(req, treasuryIdOnlyQuerySchema);
  const { treasury, signers } = await loadTreasuryWithSigners(treasuryId);
  await requireMember(treasury.community_id, session.wallet);
  const sdk = requireSdkDrep(treasury, signers);
  const status = await fetchDrepStatus(asNetwork(treasury.network), sdk.dRepId);
  return {
    dRepId: sdk.dRepId,
    active: status.active,
    votingPower: status.votingPower,
    metaUrl: status.metaUrl,
  } satisfies DrepStatusResponse;
});
