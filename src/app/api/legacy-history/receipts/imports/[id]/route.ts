// Remove one receipts import with every line it added.
import { sessionRoute } from "@/lib/api/route";
import type { OkResponse } from "@/lib/api/types";
import { deleteLegacyReceiptImport } from "@/lib/db/legacyHistory";
import { requireLegacyReceiptImportAdmin } from "@/lib/legacyHistory/access";

export const DELETE = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const row = await requireLegacyReceiptImportAdmin(params.id, session.wallet);
  await deleteLegacyReceiptImport(row.id);
  return { ok: true } satisfies OkResponse;
});
