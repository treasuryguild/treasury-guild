// Remove one imported history line (its import goes too once it is empty).
import { sessionRoute } from "@/lib/api/route";
import type { OkResponse } from "@/lib/api/types";
import { deleteLegacyPayment } from "@/lib/db/legacyHistory";
import { requireLegacyPaymentAdmin } from "@/lib/legacyHistory/access";

export const DELETE = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const row = await requireLegacyPaymentAdmin(params.id, session.wallet);
  await deleteLegacyPayment(row.id, row.import_id);
  return { ok: true } satisfies OkResponse;
});
