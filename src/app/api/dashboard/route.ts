import { parseQuery, sessionRoute } from "@/lib/api/route";
import { dashboardQuerySchema } from "@/lib/api/schemas";
import type { DashboardResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import { currentBudgetMonth, monthDate } from "@/lib/budgets";
import { loadBudgetDashboard } from "@/lib/db/budgetDashboard";
import { loadDashboardActivity, loadRecentIncoming } from "@/lib/db/dashboard";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId, month, view } = parseQuery(req, dashboardQuerySchema);
  await requireMember(communityId, session.wallet);

  // All time runs through today whatever month the picker still holds.
  const selected = view === "all" ? currentBudgetMonth() : month ?? currentBudgetMonth();
  const now = monthDate(selected);
  const [budgets, activity, incoming] = await Promise.all([
    loadBudgetDashboard(communityId, now, view),
    loadDashboardActivity(communityId, selected, view),
    loadRecentIncoming(communityId),
  ]);

  return { ...budgets, ...activity, incoming } satisfies DashboardResponse;
});
