// Remove one history import with every line it added.
import { sessionRoute } from "@/lib/api/route";
import type { OkResponse } from "@/lib/api/types";
import { deleteLegacyImport } from "@/lib/db/legacyHistory";
import { requireLegacyImportAdmin } from "@/lib/legacyHistory/access";

export const DELETE = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const row = await requireLegacyImportAdmin(params.id, session.wallet);
  await deleteLegacyImport(row.id);
  return { ok: true } satisfies OkResponse;
});
