import { parseJson, sessionRoute } from "@/lib/api/route";
import { communityIdSchema } from "@/lib/api/schemas";
import type { JoinCommunityResponse } from "@/lib/api/types";
import { Visibility } from "@/lib/constants";
import { requireCommunity } from "@/lib/db/communities";
import { addMember } from "@/lib/db/membership";
import { ForbiddenError } from "@/lib/errors";

// One-click join for public communities. Private communities are joined via
// an invite link, GitHub auto-join, call check-in, or an admin adding the
// member — never through this route.
export const POST = sessionRoute(async (req, { session }) => {
  const { communityId } = await parseJson(req, communityIdSchema);

  const community = await requireCommunity(communityId);
  if (community.visibility !== Visibility.Public) {
    throw new ForbiddenError("This community is invite-only");
  }

  await addMember(communityId, session.wallet);
  return { ok: true, slug: community.slug } satisfies JoinCommunityResponse;
});
