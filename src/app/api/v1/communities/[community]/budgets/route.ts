// Budget against spending for a period (?month=YYYY-MM&view=month|quarter|recurring).
import { v1Route } from "@/lib/api/route";
import { budgetSummary } from "@/lib/api/v1/budgets";

export const GET = v1Route<{ community: string }>(budgetSummary);
