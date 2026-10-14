// Add an outside funder of the community: a grant treasury, Project Catalyst,
// a sponsor. What it committed is added as commitments.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { fundingSourceSchema } from "@/lib/api/schemas";
import type { FundingCreatedResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { createFundingSource } from "@/lib/db/funding";

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, name, description, url } = await parseJson(req, fundingSourceSchema);
  await requireAdmin(communityId, session.wallet);
  const source = await createFundingSource({
    community_id: communityId,
    name: name.trim(),
    description: description?.trim() || null,
    url: url ?? null,
    created_by: session.wallet,
  });
  return { id: source.id } satisfies FundingCreatedResponse;
});
