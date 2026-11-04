// Remove one receipt line.
import { sessionRoute } from "@/lib/api/route";
import type { OkResponse } from "@/lib/api/types";
import { deleteLegacyReceipt } from "@/lib/db/legacyHistory";
import { requireLegacyReceiptAdmin } from "@/lib/legacyHistory/access";

export const DELETE = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const row = await requireLegacyReceiptAdmin(params.id, session.wallet);
  await deleteLegacyReceipt(row.id, row.import_id);
  return { ok: true } satisfies OkResponse;
});
