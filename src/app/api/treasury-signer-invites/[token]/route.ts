// Preview an SDK signer invite: community and treasury name, and how many
// signers have connected. No payment addresses, stake addresses or DRep hashes.
import { parseInput } from "@/lib/api/parse";
import { clientIp, publicRoute } from "@/lib/api/route";
import { inviteTokenSchema } from "@/lib/api/schemas";
import type { SignerInvitePreviewResponse } from "@/lib/api/types";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { previewSignerDraft } from "@/lib/db/signerDrafts";
import { NotFoundError } from "@/lib/errors";

export const GET = publicRoute<{ token: string }>(async (req, { params }) => {
  const token = parseInput(inviteTokenSchema, params.token);
  await enforceRateLimit("signerDraftPreview", clientIp(req));
  const preview = await previewSignerDraft(token);
  if (!preview) throw new NotFoundError("Signer invite not found");
  return {
    communityName: preview.communityName,
    treasuryName: preview.treasuryName,
    slug: preview.slug,
    network: preview.network,
    expiresAt: preview.expiresAt,
    valid: preview.valid,
    filled: preview.filled,
    total: preview.total,
  } satisfies SignerInvitePreviewResponse;
});
