// A workgroup's payment wallet over time. GET: the wallet in force, the
// period a change would start in and the dated history. POST: schedule a
// change for this or the next budget period (admin). The rules live in the
// set_workgroup_treasury RPC (migration 0035).
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import { workgroupIdQuerySchema, workgroupRoutingSchema } from "@/lib/api/schemas";
import type { WorkgroupRoutingResponse, WorkgroupRoutingStatus } from "@/lib/api/types";
import { requireAdmin, requireMember } from "@/lib/authz";
import { loadWorkgroupRouting, setWorkgroupTreasury } from "@/lib/db/workgroupRouting";
import { requireWorkgroupCommunity } from "@/lib/db/workgroups";
import { NotFoundError } from "@/lib/errors";

export const GET = sessionRoute(async (req, { session }) => {
  const { workgroupId } = parseQuery(req, workgroupIdQuerySchema);
  await requireMember(await requireWorkgroupCommunity(workgroupId), session.wallet);
  const data = await loadWorkgroupRouting(workgroupId);
  if (!data) throw new NotFoundError("Workgroup not found");
  return data as WorkgroupRoutingStatus & Record<string, unknown>;
});

export const POST = sessionRoute(async (req, { session }) => {
  const { workgroupId, treasuryId, effective, reason } = await parseJson(req, workgroupRoutingSchema);
  await requireAdmin(await requireWorkgroupCommunity(workgroupId), session.wallet);
  const startsOn = await setWorkgroupTreasury({
    workgroupId, treasuryId, effective, actor: session.wallet, reason,
  });
  return { startsOn } satisfies WorkgroupRoutingResponse;
});
