// Parse and plan an uploaded receipts CSV without writing anything.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { legacyReceiptUploadSchema } from "@/lib/api/schemas";
import type { LegacyReceiptPreview } from "@/lib/api/types";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { NotFoundError } from "@/lib/errors";
import { requireLegacyReceiptImportAdmin, requireLegacyWalletAdmin } from "@/lib/legacyHistory/access";
import { previewReceiptRows } from "@/lib/legacyHistory/receiptPlan";
import { planLegacyReceiptUpload } from "@/lib/legacyHistory/receiptRun";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, legacyReceiptUploadSchema);
  const wallet = await requireLegacyWalletAdmin(body.legacyWalletId, session.wallet);
  if (wallet.community_id !== body.communityId) throw new NotFoundError("Previous wallet not found");
  if (body.replaceImportId) {
    const replaced = await requireLegacyReceiptImportAdmin(body.replaceImportId, session.wallet);
    if (replaced.legacy_wallet_id !== wallet.id) throw new NotFoundError("Receipt import not found");
  }
  await enforceRateLimit("legacyHistory", session.wallet);

  const plan = await planLegacyReceiptUpload({
    communityId: wallet.community_id,
    walletId: wallet.id,
    csv: body.csv,
    tickerUnits: body.tickerUnits,
    sourceMap: body.sourceMap,
    commitmentMap: body.commitmentMap,
    defaultSourceId: body.defaultSourceId ?? null,
    defaultCommitmentId: body.defaultCommitmentId ?? null,
    replaceImportId: body.replaceImportId ?? null,
    includeDuplicates: body.includeDuplicates,
    now: new Date(),
  });
  const { rows, truncated } = previewReceiptRows(plan);
  return { ...plan, rows, rowsTruncated: truncated } satisfies LegacyReceiptPreview;
});
