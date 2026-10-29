// The creating admin sends their own stake address and optional DRep hash,
// read from the wallet they are connected with. The RPC writes only that
// session wallet's row.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { signerDraftKeysSchema } from "@/lib/api/schemas";
import type { SignerDraftResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { contributeSignerDraftById, getSignerDraft } from "@/lib/db/signerDrafts";
import { NotFoundError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, signerDraftKeysSchema);
  const existing = await getSignerDraft(body.draftId);
  if (!existing) throw new NotFoundError("Signer invite not found");
  await requireAdmin(existing.communityId, session.wallet);
  await enforceRateLimit("signerDraftContribute", session.wallet);
  const draft = await contributeSignerDraftById(
    body.draftId,
    session.wallet,
    body.stakeAddress,
    body.drepKeyHash ?? null,
  );
  return { draft } satisfies SignerDraftResponse;
});
