// A page of imported receipt lines, of one import or one wallet.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { legacyRowsQuerySchema } from "@/lib/api/schemas";
import type { LegacyReceiptRowsResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { loadLegacyReceiptRows } from "@/lib/db/legacyHistory";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId, importId, walletId, offset } = parseQuery(req, legacyRowsQuerySchema);
  await requireAdmin(communityId, session.wallet);
  const { rows, total } = await loadLegacyReceiptRows(communityId, { importId, walletId, offset });
  return { rows, total, offset } satisfies LegacyReceiptRowsResponse;
});
