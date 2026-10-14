// Import an uploaded payment-history CSV. The file is parsed and planned
// again here (the browser's preview is never trusted) and written in one
// transaction by import_legacy_history, which skips lines this wallet already
// holds unless the admin asked to include them. With replaceImportId the old
// batch is swapped for this file atomically.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { legacyUploadSchema } from "@/lib/api/schemas";
import type { LegacyHistoryImportResponse } from "@/lib/api/types";
import { importLegacyHistory } from "@/lib/db/legacyHistory";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { requireLegacyImportAdmin, requireLegacyWalletAdmin } from "@/lib/legacyHistory/access";
import { legacyRpcRows } from "@/lib/legacyHistory/plan";
import { planLegacyUpload } from "@/lib/legacyHistory/run";

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
  if (!plan.ready) {
    throw new BadRequestError(
      plan.issues.some((i) => i.severity === "error")
        ? "The file cannot be imported as it is. Preview it and fix what it lists."
        : "Nothing new to import: every line is already here.",
    );
  }
  const result = await importLegacyHistory({
    walletId: wallet.id,
    fileName: body.fileName.trim(),
    actor: session.wallet,
    rows: legacyRpcRows(plan, body.includeDuplicates),
    replaceImportId: body.replaceImportId ?? null,
    includeDuplicates: body.includeDuplicates,
  });
  return { ...result } satisfies LegacyHistoryImportResponse;
});
