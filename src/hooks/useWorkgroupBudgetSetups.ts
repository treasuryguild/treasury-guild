"use client";

import type { BudgetSetup } from "@/lib/budgetSetups";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncData } from "./useAsyncData";

export type WorkgroupBudgetSetup = Pick<BudgetSetup, "starts_on" | "cadence">;

/**
 * Start dates and cadences of a workgroup's budget setups (member-readable),
 * so the task editor can tell whether the workgroup is budgeted by quarter.
 */
export function useWorkgroupBudgetSetups(
  workgroupId: string,
  enabled: boolean,
): WorkgroupBudgetSetup[] {
  const { data } = useAsyncData(enabled ? workgroupId : null, async () => {
    const { data: rows, error } = await browserClient()
      .from("budget_setups")
      .select("starts_on, cadence")
      .eq("workgroup_id", workgroupId);
    if (error) throw new Error(error.message);
    return (rows ?? []) as WorkgroupBudgetSetup[];
  });
  return data ?? [];
}

/**
 * A treasury's own setup timeline (member-readable), so the Payments page
 * can tell whether the treasury budgets manual payments by quarter.
 */
export function useTreasuryBudgetSetups(
  treasuryId: string | null | undefined,
): WorkgroupBudgetSetup[] {
  const { data } = useAsyncData(treasuryId || null, async () => {
    const { data: rows, error } = await browserClient()
      .from("budget_setups")
      .select("starts_on, cadence")
      .eq("treasury_id", treasuryId);
    if (error) throw new Error(error.message);
    return (rows ?? []) as WorkgroupBudgetSetup[];
  });
  return data ?? [];
}

const NO_SETUPS: ReadonlyMap<string, WorkgroupBudgetSetup[]> = new Map();

/**
 * The same, for every workgroup of a community at once, keyed by workgroup
 * id (Payday edits tasks from many workgroups). Workgroups with no setup are
 * absent.
 */
export function useCommunityBudgetSetups(
  communityId: string | null | undefined,
  enabled: boolean,
): ReadonlyMap<string, WorkgroupBudgetSetup[]> {
  const { data } = useAsyncData(enabled ? communityId : null, async () => {
    const { data: rows, error } = await browserClient()
      .from("budget_setups")
      .select("workgroup_id, starts_on, cadence, workgroups!inner(community_id)")
      .eq("workgroups.community_id", communityId);
    if (error) throw new Error(error.message);
    const byWorkgroup = new Map<string, WorkgroupBudgetSetup[]>();
    for (const row of (rows ?? []) as unknown as (WorkgroupBudgetSetup & { workgroup_id: string })[]) {
      const list = byWorkgroup.get(row.workgroup_id) ?? [];
      list.push({ starts_on: row.starts_on, cadence: row.cadence });
      byWorkgroup.set(row.workgroup_id, list);
    }
    return byWorkgroup;
  });
  return data ?? NO_SETUPS;
}
