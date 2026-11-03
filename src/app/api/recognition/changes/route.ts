// Recognition settings change log for the settings page.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { communityIdSchema } from "@/lib/api/schemas";
import { requireMember } from "@/lib/authz";
import { listRecognitionSettingChanges } from "@/lib/db/recognition";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, communityIdSchema);
  await requireMember(communityId, session.wallet);
  return { changes: await listRecognitionSettingChanges(communityId) };
});
