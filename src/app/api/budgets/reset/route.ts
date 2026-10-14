import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import { budgetResetSchema, workgroupIdQuerySchema } from "@/lib/api/schemas";
import type { BudgetResetStatus } from "@/lib/api/types";
import { requireWorkgroupAdmin } from "@/lib/authz";
import { loadBudgetResetStatus, resetWorkgroupBudgets } from "@/lib/db/budgetSetups";
import { NotFoundError } from "@/lib/errors";

export const GET = sessionRoute(async (req, { session }) => {
  const { workgroupId } = parseQuery(req, workgroupIdQuerySchema);
  await requireWorkgroupAdmin(workgroupId, session.wallet);
  const data = await loadBudgetResetStatus(workgroupId);
  if (!data) throw new NotFoundError("Workgroup not found");
  return data as BudgetResetStatus & Record<string, unknown>;
});

export const POST = sessionRoute(async (req, { session }) => {
  const { workgroupId, expectedRevision, confirmation, reason } = await parseJson(req, budgetResetSchema);
  await requireWorkgroupAdmin(workgroupId, session.wallet);
  const revision = await resetWorkgroupBudgets({
    workgroupId, expectedRevision, actor: session.wallet, confirmation, reason,
  });
  return { revision };
});
