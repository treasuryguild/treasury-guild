// Parse and plan an uploaded payment-history CSV without writing anything:
// the rows, what cannot be imported and why, the tokens and workgroups still
// to choose, what is already here, and the totals an import would add.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { legacyUploadSchema } from "@/lib/api/schemas";
import type { LegacyHistoryPreview } from "@/lib/api/types";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { requireLegacyImportAdmin, requireLegacyWalletAdmin } from "@/lib/legacyHistory/access";
import { previewRows } from "@/lib/legacyHistory/plan";
import { planLegacyUpload } from "@/lib/legacyHistory/run";
import { NotFoundError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, legacyUploadSchema);
  const wallet = await requireLegacyWalletAdmin(body.legacyWalletId, session.wallet);
  if (wallet.community_id !== body.communityId) throw new NotFoundError("Previous wallet not found");
  if (body.replaceImportId) {
    const replaced = await requireLegacyImportAdmin(body.replaceImportId, session.wallet);
    if (replaced.legacy_wallet_id !== wallet.id) throw new NotFoundError("Import not found");
  }
  await enforceRateLimit("legacyHistory", session.wallet);

  const plan = await planLegacyUpload({
    communityId: wallet.community_id,
    walletId: wallet.id,
    csv: body.csv,
    tickerUnits: body.tickerUnits,
    replaceImportId: body.replaceImportId ?? null,
    includeDuplicates: body.includeDuplicates,
    now: new Date(),
  });
  const { rows, truncated } = previewRows(plan);
  return { ...plan, rows, rowsTruncated: truncated } satisfies LegacyHistoryPreview;
});
