import { requireActiveWorkgroup } from "@/lib/db/workgroups";
import { monthDate } from "@/lib/budgets";
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import {
  budgetsQuerySchema,
  saveBudgetSetupSchema,
} from "@/lib/api/schemas";
import type { BudgetsResponse } from "@/lib/api/types";
import { requireAdmin, requireMember, requireWorkgroupManager } from "@/lib/authz";
import { loadBudgetDashboard } from "@/lib/db/budgetDashboard";
import { loadTreasuryBudgetOwner, loadWorkgroupBudgetOwner, resolveBudgetAmounts, saveBudgetSetup } from "@/lib/db/budgetSave";
import { BadRequestError } from "@/lib/errors";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId, month: selectedMonth, view } = parseQuery(req, budgetsQuerySchema);
  await requireMember(communityId, session.wallet);

  const now = selectedMonth ? monthDate(selectedMonth) : new Date();
  const dashboard = await loadBudgetDashboard(communityId, now, view);
  return { ...dashboard } satisfies BudgetsResponse;
});

// With budget consent on, save_budget_setup refuses (guard_budget_consent):
// budgets then change through /api/proposals.
export const POST = sessionRoute(async (req, { session }) => {
  const {
    workgroupId, treasuryId, budgets, budgetCadence, mode, startsOn, expectedRevision, confirmTransition, reason,
  } = await parseJson(req, saveBudgetSetupSchema);
  if (budgets.some((budget) => BigInt(budget.amount) <= 0n)) {
    throw new BadRequestError("Each budget must be greater than zero");
  }

  let owner;
  if (treasuryId) {
    // A treasury's budget covers manual payments made from it: admins only.
    owner = await loadTreasuryBudgetOwner(treasuryId);
    await requireAdmin(owner.communityId, session.wallet);
  } else {
    owner = await loadWorkgroupBudgetOwner(workgroupId!);
    await requireWorkgroupManager(
      owner.communityId, workgroupId!, session.wallet,
      "Only admins and workgroup leads can manage budgets",
    );
    await requireActiveWorkgroup(workgroupId!);
  }

  const budgetRows = await resolveBudgetAmounts(owner, budgets, session.wallet);
  const revision = await saveBudgetSetup({
    workgroupId: workgroupId ?? null, treasuryId: treasuryId ?? null, expectedRevision,
    mode, cadence: budgetCadence, startsOn: startsOn + "-01",
    amounts: budgetRows, actor: session.wallet, confirm: confirmTransition, reason,
  });
  return { ok: true, revision };
});
