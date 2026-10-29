// Active Cardano governance proposals (Koios), for SDK treasury voting UI.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { treasuryIdOnlyQuerySchema } from "@/lib/api/schemas";
import type { ChainProposalsResponse } from "@/lib/api/types";
import { fetchActiveProposals } from "@/lib/cardano/koios";
import { requireSdkVote } from "@/lib/cardano/sdkTreasury";
import { requireMember } from "@/lib/authz";
import { loadTreasuryWithSigners } from "@/lib/db/treasuries";
import { asNetwork } from "@/lib/config";

export const GET = sessionRoute(async (req, { session }) => {
  const { treasuryId } = parseQuery(req, treasuryIdOnlyQuerySchema);
  const { treasury, signers } = await loadTreasuryWithSigners(treasuryId);
  await requireMember(treasury.community_id, session.wallet);
  requireSdkVote(treasury, signers);
  const proposals = await fetchActiveProposals(asNetwork(treasury.network));
  return {
    proposals: proposals.map((p) => ({
      txHash: p.tx_hash,
      certIndex: p.cert_index,
      type: p.governance_type ?? null,
      title: p.meta_title ?? null,
      abstract: p.meta_abstract ?? null,
      metaUrl: p.meta_url ?? null,
      expiration: p.expiration ?? null,
    })),
  } satisfies ChainProposalsResponse;
});
