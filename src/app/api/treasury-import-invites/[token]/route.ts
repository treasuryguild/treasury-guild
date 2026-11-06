// Preview a CBOR / CIP-0146 import invite: community and treasury name, and
// how many signers have claimed. No key hashes or payment addresses.
import { parseInput } from "@/lib/api/parse";
import { clientIp, publicRoute } from "@/lib/api/route";
import { inviteTokenSchema } from "@/lib/api/schemas";
import type { ImportInvitePreviewResponse } from "@/lib/api/types";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { previewImportDraft } from "@/lib/db/importDrafts";
import { NotFoundError } from "@/lib/errors";

export const GET = publicRoute<{ token: string }>(async (req, { params }) => {
  const token = parseInput(inviteTokenSchema, params.token);
  await enforceRateLimit("importDraftPreview", clientIp(req));
  const preview = await previewImportDraft(token);
  if (!preview) throw new NotFoundError("Import invite not found");
  return {
    communityName: preview.communityName,
    treasuryName: preview.treasuryName,
    slug: preview.slug,
    network: preview.network,
    expiresAt: preview.expiresAt,
    valid: preview.valid,
    filled: preview.filled,
    total: preview.total,
  } satisfies ImportInvitePreviewResponse;
});
