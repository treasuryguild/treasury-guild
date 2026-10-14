// An admin's actions on one held on-chain transaction: try the import again,
// import the conflicting tasks under new numbers, dismiss it, or bring a
// dismissed one back.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { chainImportResolveSchema } from "@/lib/api/schemas";
import type { ChainImportRunResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { importExternalTxs } from "@/lib/chainImport/run";
import { ChainImportStatus } from "@/lib/constants";
import { loadExternalTx, loadImportTreasury, markExternalTx } from "@/lib/db/chainImport";
import { BadRequestError, NotFoundError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const { txHash, action, chainNumbers } = await parseJson(req, chainImportResolveSchema);
  const hash = txHash.toLowerCase();
  // Imported in the meantime (the cron, another admin): the row is gone.
  const row = await loadExternalTx(hash);
  if (!row) throw new NotFoundError("This transaction is no longer waiting for import");
  const treasury = await loadImportTreasury(row.treasury_id);
  if (!treasury) throw new NotFoundError("Treasury not found");
  await requireAdmin(treasury.community_id, session.wallet);

  if (action === "ignore") {
    await markExternalTx(hash, ChainImportStatus.Ignored, row.import_issues);
    return { imported: [], blocked: [] } satisfies ChainImportRunResponse;
  }
  if (action === "new_number" && !chainNumbers?.length) {
    throw new BadRequestError("Choose the task numbers to import under a new number");
  }
  return importExternalTxs(treasury, {
    hashes: [hash],
    asNewNumbers: action === "new_number" ? chainNumbers : undefined,
    limit: 1,
  }) satisfies Promise<ChainImportRunResponse>;
});
