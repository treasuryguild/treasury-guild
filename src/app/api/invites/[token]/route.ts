// Preview an invite token: community name and whether the link still works.
// No session required; rate-limited by IP so tokens cannot be walked cheaply.
import { parseInput } from "@/lib/api/parse";
import { clientIp, publicRoute } from "@/lib/api/route";
import { inviteTokenSchema } from "@/lib/api/schemas";
import type { InvitePreviewResponse } from "@/lib/api/types";
import { previewInvite } from "@/lib/db/invites";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { NotFoundError } from "@/lib/errors";

export const GET = publicRoute<{ token: string }>(async (req, { params }) => {
  const token = parseInput(inviteTokenSchema, params.token);
  await enforceRateLimit("invitePreview", clientIp(req));
  const preview = await previewInvite(token);
  if (!preview) throw new NotFoundError("Invite not found");
  return {
    name: preview.name,
    slug: preview.slug,
    network: preview.network,
    valid: preview.valid,
  } satisfies InvitePreviewResponse;
});
