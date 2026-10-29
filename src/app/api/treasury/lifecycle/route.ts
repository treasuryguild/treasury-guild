// Archive or restore a treasury. The row stays, so its transactions and
// on-chain anchor links stay with it. Admins only; the database repeats the
// checks (primary, a transaction still in progress, a workgroup still paid
// from it).
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import { treasuryIdQuerySchema, treasuryLifecycleSchema } from "@/lib/api/schemas";
import type { OkResponse, TreasuryLifecycleStatus } from "@/lib/api/types";
import { requireTreasuryAdmin } from "@/lib/authz";
import { changeTreasuryLifecycle, loadTreasuryLifecycleStatus } from "@/lib/db/treasuries";
import { NotFoundError } from "@/lib/errors";

export const GET = sessionRoute(async (req, { session }) => {
  const { treasuryId } = parseQuery(req, treasuryIdQuerySchema);
  await requireTreasuryAdmin(treasuryId, session.wallet);
  const data = await loadTreasuryLifecycleStatus(treasuryId);
  if (!data) throw new NotFoundError("Treasury not found");
  return data as TreasuryLifecycleStatus & Record<string, unknown>;
});

export const POST = sessionRoute(async (req, { session }) => {
  const { treasuryId, action } = await parseJson(req, treasuryLifecycleSchema);
  await requireTreasuryAdmin(treasuryId, session.wallet);
  await changeTreasuryLifecycle({ treasuryId, action, actor: session.wallet });
  return { ok: true } satisfies OkResponse;
});
