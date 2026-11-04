// Import an uploaded receipts CSV. Re-parsed and planned here; written by
// import_legacy_receipts in one transaction.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { legacyReceiptUploadSchema } from "@/lib/api/schemas";
import type { LegacyHistoryImportResponse } from "@/lib/api/types";
import { importLegacyReceipts } from "@/lib/db/legacyHistory";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { requireLegacyReceiptImportAdmin, requireLegacyWalletAdmin } from "@/lib/legacyHistory/access";
import { legacyReceiptRpcRows } from "@/lib/legacyHistory/receiptPlan";
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
    replaceImportId: body.replaceImportId ?? null,
    includeDuplicates: body.includeDuplicates,
    now: new Date(),
  });
  if (!plan.ready) {
    throw new BadRequestError(
      plan.issues.some((i) => i.severity === "error")
        ? "The file cannot be imported as it is. Preview it and fix what it lists."
        : "Nothing new to import: every line is already here.",
    );
  }
  const result = await importLegacyReceipts({
    walletId: wallet.id,
    fileName: body.fileName.trim(),
    actor: session.wallet,
    rows: legacyReceiptRpcRows(plan, body.includeDuplicates),
    replaceImportId: body.replaceImportId ?? null,
    includeDuplicates: body.includeDuplicates,
  });
  return { ...result } satisfies LegacyHistoryImportResponse;
});
