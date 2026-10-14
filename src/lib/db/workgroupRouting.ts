// Reads of the dated workgroup → treasury routing (migration 0035). The
// resolver is `routedTreasuryAt` in lib/workgroupRouting.ts.
import "server-only";

import type { WorkgroupRoutingStatus } from "@/lib/api/types";
import type { TreasuryAssignment } from "@/lib/workgroupRouting";
import { rows, rpc, serviceClient } from "./client";

/**
 * Schedule a workgroup's payment wallet for this or the next budget period
 * through the `set_workgroup_treasury` RPC, which owns the rules (admin actor,
 * same community, not archived, period not already paid from another wallet,
 * no later change scheduled). Returns the effective `starts_on`.
 */
export async function setWorkgroupTreasury(input: {
  workgroupId: string;
  treasuryId: string | null;
  effective: "current" | "next";
  actor: string;
  reason?: string | null;
}): Promise<string> {
  const data = rpc<string>(
    await serviceClient().rpc("set_workgroup_treasury", {
      p_workgroup_id: input.workgroupId, p_treasury_id: input.treasuryId, p_effective: input.effective,
      p_actor: input.actor, p_reason: input.reason ?? null,
    }),
  );
  return String(data);
}

/**
 * Every assignment of the given workgroups, keyed by workgroup id. A
 * workgroup with no row is absent (any wallet). The payout build resolves
 * each task's wallet from this for the task's budget period.
 */
export async function loadTreasuryAssignmentsForWorkgroups(
  workgroupIds: readonly string[],
): Promise<Map<string, TreasuryAssignment[]>> {
  const byWorkgroup = new Map<string, TreasuryAssignment[]>();
  if (workgroupIds.length === 0) return byWorkgroup;
  const list = rows<TreasuryAssignment & { workgroup_id: string }>(
    await serviceClient()
      .from("workgroup_treasury_assignments")
      .select("workgroup_id, treasury_id, starts_on")
      .in("workgroup_id", [...workgroupIds]),
    "load workgroup treasury assignments",
  );
  for (const { workgroup_id, treasury_id, starts_on } of list) {
    const assignments = byWorkgroup.get(workgroup_id) ?? [];
    assignments.push({ treasury_id, starts_on });
    byWorkgroup.set(workgroup_id, assignments);
  }
  return byWorkgroup;
}

/** The wallet in force, the period a change would start in and the dated history; null when the workgroup is gone. */
export async function loadWorkgroupRouting(workgroupId: string): Promise<WorkgroupRoutingStatus | null> {
  return rpc<WorkgroupRoutingStatus | null>(
    await serviceClient().rpc("workgroup_treasury_routing", { p_workgroup_id: workgroupId }),
  );
}
