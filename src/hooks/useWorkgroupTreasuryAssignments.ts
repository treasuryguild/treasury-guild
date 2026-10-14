"use client";

import { browserClient } from "@/lib/supabase/browser";
import type { TreasuryAssignment } from "@/lib/workgroupRouting";
import { useAsyncData } from "./useAsyncData";

const NONE: ReadonlyMap<string, TreasuryAssignment[]> = new Map();

/**
 * Every workgroup's dated wallet routing for a community (member-readable),
 * keyed by workgroup id, so Payday can tell which wallet a task's own budget
 * period is paid from. Workgroups with no assignment are absent (any wallet).
 */
export function useWorkgroupTreasuryAssignments(
  communityId: string | null | undefined,
): ReadonlyMap<string, TreasuryAssignment[]> {
  const { data } = useAsyncData(communityId ?? null, async () => {
    const { data: rows, error } = await browserClient()
      .from("workgroup_treasury_assignments")
      .select("workgroup_id, treasury_id, starts_on, workgroups!inner(community_id)")
      .eq("workgroups.community_id", communityId);
    if (error) throw new Error(error.message);
    const byWorkgroup = new Map<string, TreasuryAssignment[]>();
    for (const row of (rows ?? []) as { workgroup_id: string; treasury_id: string | null; starts_on: string }[]) {
      const list = byWorkgroup.get(row.workgroup_id) ?? [];
      list.push({ treasury_id: row.treasury_id, starts_on: row.starts_on });
      byWorkgroup.set(row.workgroup_id, list);
    }
    return byWorkgroup as ReadonlyMap<string, TreasuryAssignment[]>;
  });
  return data ?? NONE;
}
