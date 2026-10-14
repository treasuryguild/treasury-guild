import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import { workgroupIdQuerySchema, workgroupLifecycleSchema } from "@/lib/api/schemas";
import type { OkResponse, WorkgroupLifecycleStatus } from "@/lib/api/types";
import { requireWorkgroupAdmin } from "@/lib/authz";
import { changeWorkgroupLifecycle, loadWorkgroupLifecycleStatus } from "@/lib/db/workgroups";
import { NotFoundError } from "@/lib/errors";

export const GET = sessionRoute(async (req, { session }) => {
  const { workgroupId } = parseQuery(req, workgroupIdQuerySchema);
  await requireWorkgroupAdmin(workgroupId, session.wallet);
  const data = await loadWorkgroupLifecycleStatus(workgroupId);
  if (!data) throw new NotFoundError("Workgroup not found");
  return data as WorkgroupLifecycleStatus & Record<string, unknown>;
});

export const POST = sessionRoute(async (req, { session }) => {
  const { workgroupId, action, confirmation } = await parseJson(req, workgroupLifecycleSchema);
  await requireWorkgroupAdmin(workgroupId, session.wallet);
  await changeWorkgroupLifecycle({
    workgroupId, action, actor: session.wallet, confirmation: confirmation ?? null,
  });
  return { ok: true } satisfies OkResponse;
});
