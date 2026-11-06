// Admin paste: claim one import-draft slot with a payment address that hashes
// to that key.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { importDraftSlotSchema } from "@/lib/api/schemas";
import type { ImportDraftResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { asNetwork } from "@/lib/config";
import { requireCommunity } from "@/lib/db/communities";
import { adminSetImportSlot } from "@/lib/db/importDrafts";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, importDraftSlotSchema);
  await requireAdmin(body.communityId, session.wallet);
  await enforceRateLimit("importDraftClaim", session.wallet);
  const community = await requireCommunity(body.communityId);
  const draft = await adminSetImportSlot({
    draftId: body.draftId,
    communityId: body.communityId,
    keyHash: body.keyHash,
    address: body.address,
    name: body.name,
    network: asNetwork(community.network),
  });
  return { draft } satisfies ImportDraftResponse;
});
