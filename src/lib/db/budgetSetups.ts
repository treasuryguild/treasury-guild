import "server-only";

import type { BudgetResetStatus } from "@/lib/api/types";
import type { BudgetPlanSource, BudgetSetup, BudgetSetupSource } from "@/lib/budgetSetups";
import { rows, rpc, serviceClient } from "./client";

export type BudgetSetupCadenceRow = Pick<BudgetSetup, "starts_on" | "cadence">;

/** The setup and plan rows of these owners (`budget_owner_key`s), with the proposal that set each (0059). */
export interface BudgetSources {
  /** Keyed by owner key; owners with no setup are absent. */
  setups: Map<string, BudgetSetupSource[]>;
  plans: BudgetPlanSource[];
}

/**
 * Everything `budgetInForce` needs for these owners: the full timelines with
 * amounts and the plan rows of every listed setup. The build routes read
 * this once for citations and the spending check.
 */
export async function loadBudgetSources(ownerKeys: readonly string[]): Promise<BudgetSources> {
  const setups = new Map<string, BudgetSetupSource[]>();
  if (ownerKeys.length === 0) return { setups, plans: [] };
  const db = serviceClient();
  const list = rows<BudgetSetupSource>(
    await db
      .from("budget_setups")
      .select("id, owner_key, starts_on, mode, cadence, amounts, proposal_id")
      .in("owner_key", [...ownerKeys]),
    "load budget setups",
  );
  for (const setup of list) {
    const timeline = setups.get(setup.owner_key) ?? [];
    timeline.push(setup);
    setups.set(setup.owner_key, timeline);
  }
  const plans = list.length === 0 ? [] : rows<BudgetPlanSource>(
    await db
      .from("budget_plans")
      .select("setup_id, starts_on, amounts, proposal_id")
      .in("setup_id", list.map((s) => s.id)),
    "load budget plans",
  );
  return { setups, plans };
}

/** The mode and cadence of the owner's setup in force on `startsOn` ("YYYY-MM-01"), or null when none is. */
export async function loadSetupInForce(
  ownerKey: string,
  startsOn: string,
): Promise<Pick<BudgetSetup, "mode" | "cadence"> | null> {
  return rows<Pick<BudgetSetup, "mode" | "cadence">>(
    await serviceClient()
      .from("budget_setups")
      .select("mode, cadence")
      .eq("owner_key", ownerKey)
      .lte("starts_on", startsOn)
      .order("starts_on", { ascending: false })
      .limit(1),
    "load budget setup in force",
  )[0] ?? null;
}

/**
 * Every workgroup's setup timeline (start date + cadence only), keyed by
 * workgroup id. Workgroups with no setup are absent. The payout build reads
 * this to align each task with the period in force for its budget month.
 */
export async function loadBudgetSetupsForWorkgroups(
  workgroupIds: string[],
): Promise<Map<string, BudgetSetupCadenceRow[]>> {
  const byWorkgroup = new Map<string, BudgetSetupCadenceRow[]>();
  if (workgroupIds.length === 0) return byWorkgroup;
  const list = rows<BudgetSetupCadenceRow & { workgroup_id: string }>(
    await serviceClient()
      .from("budget_setups")
      .select("workgroup_id, starts_on, cadence")
      .in("workgroup_id", workgroupIds),
    "load budget setups",
  );
  for (const { workgroup_id, starts_on, cadence } of list) {
    const setups = byWorkgroup.get(workgroup_id) ?? [];
    setups.push({ starts_on, cadence });
    byWorkgroup.set(workgroup_id, setups);
  }
  return byWorkgroup;
}

/**
 * The same for treasury budgets, keyed by treasury id. The Dashboard reads it
 * to place manual payments of a quarterly treasury budget.
 */
export async function loadBudgetSetupsForTreasuries(
  treasuryIds: string[],
): Promise<Map<string, BudgetSetupCadenceRow[]>> {
  const byTreasury = new Map<string, BudgetSetupCadenceRow[]>();
  if (treasuryIds.length === 0) return byTreasury;
  const list = rows<BudgetSetupCadenceRow & { treasury_id: string }>(
    await serviceClient()
      .from("budget_setups")
      .select("treasury_id, starts_on, cadence")
      .in("treasury_id", treasuryIds),
    "load treasury budget setups",
  );
  for (const { treasury_id, starts_on, cadence } of list) {
    const setups = byTreasury.get(treasury_id) ?? [];
    setups.push({ starts_on, cadence });
    byTreasury.set(treasury_id, setups);
  }
  return byTreasury;
}

/**
 * A treasury's own setup timeline (start date + cadence only). The payment
 * build reads this to align a manual payment with the period in force for
 * its budget month.
 */
export async function loadBudgetSetupsForTreasury(treasuryId: string): Promise<BudgetSetupCadenceRow[]> {
  return rows<BudgetSetupCadenceRow>(
    await serviceClient()
      .from("budget_setups")
      .select("starts_on, cadence")
      .eq("treasury_id", treasuryId),
    "load treasury budget setups",
  );
}

/** What resetting a workgroup's budgets would remove (budget_reset_status); null when the workgroup is gone. */
export async function loadBudgetResetStatus(workgroupId: string): Promise<BudgetResetStatus | null> {
  return rpc<BudgetResetStatus | null>(
    await serviceClient().rpc("budget_reset_status", { p_workgroup_id: workgroupId }),
  );
}

/** Reset a workgroup's budgets (reset_workgroup_budgets) and return the new revision. */
export async function resetWorkgroupBudgets(input: {
  workgroupId: string;
  expectedRevision: number;
  actor: string;
  confirmation: string;
  reason: string;
}): Promise<number> {
  return rpc<number>(
    await serviceClient().rpc("reset_workgroup_budgets", {
      p_workgroup_id: input.workgroupId, p_expected_revision: input.expectedRevision,
      p_actor: input.actor, p_confirmation: input.confirmation, p_reason: input.reason,
    }),
  );
}
