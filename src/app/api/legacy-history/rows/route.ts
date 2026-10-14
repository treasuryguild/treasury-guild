// A page of imported history lines, of one import or one wallet.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { legacyRowsQuerySchema } from "@/lib/api/schemas";
import type { LegacyRowsResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { loadLegacyRows } from "@/lib/db/legacyHistory";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId, importId, walletId, offset } = parseQuery(req, legacyRowsQuerySchema);
  await requireAdmin(communityId, session.wallet);
  return (await loadLegacyRows(communityId, { importId, walletId, offset })) satisfies LegacyRowsResponse;
});
