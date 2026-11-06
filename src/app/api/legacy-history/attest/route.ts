// Record an ownership signature for a staged previous-wallet import.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { legacyAttestSchema } from "@/lib/api/schemas";
import type { LegacyHistoryImportResponse } from "@/lib/api/types";
import { communitySlug } from "@/lib/db/communities";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { NotFoundError } from "@/lib/errors";
import {
  requireLegacyImportAdmin, requireLegacyReceiptImportAdmin, requireLegacyWalletAdmin,
} from "@/lib/legacyHistory/access";
import { attestLegacyImport } from "@/lib/legacyHistory/attest";
import { loadLegacyImport, loadLegacyReceiptImport } from "@/lib/db/legacyHistory";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, legacyAttestSchema);
  await enforceRateLimit("legacyHistory", session.wallet);

  const imp = body.kind === "payments"
    ? await loadLegacyImport(body.importId)
    : await loadLegacyReceiptImport(body.importId);
  if (!imp || imp.community_id !== body.communityId) throw new NotFoundError("Import not found");
  if (body.kind === "payments") {
    await requireLegacyImportAdmin(body.importId, session.wallet);
  } else {
    await requireLegacyReceiptImportAdmin(body.importId, session.wallet);
  }
  await requireLegacyWalletAdmin(imp.legacy_wallet_id, session.wallet);
  const slug = await communitySlug(body.communityId);

  const result = await attestLegacyImport({
    kind: body.kind,
    importId: body.importId,
    communitySlug: slug,
    signedAt: body.signedAt,
    key: body.key,
    signature: body.signature,
    signerAddress: body.signerAddress,
    actor: session.wallet,
  });

  return {
    importId: result.importId,
    state: result.state,
    planHash: imp.plan_hash ?? undefined,
    signatures: result.signatures,
    required: result.required,
    inserted: result.inserted,
    skipped: 0,
    replaced: false,
  } satisfies LegacyHistoryImportResponse;
});
