// Admin claims their connected wallet against an open import draft by id.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { importDraftClaimSchema } from "@/lib/api/schemas";
import type { ImportDraftResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { claimImportDraftById, getImportDraft } from "@/lib/db/importDrafts";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { NotFoundError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, importDraftClaimSchema);
  await enforceRateLimit("importDraftClaim", session.wallet);
  const existing = await getImportDraft(body.draftId);
  if (!existing) throw new NotFoundError("Import invite not found");
  await requireAdmin(existing.communityId, session.wallet);
  const draft = await claimImportDraftById(body.draftId, session.wallet, body.name ?? null);
  return { draft } satisfies ImportDraftResponse;
});
