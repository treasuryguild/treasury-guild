// Service-role reads and writes for Payday allocation rules (migration 0091).
import "server-only";

import { MAX_PAYDAY_ALLOCATION_RULES } from "@/lib/constants";
import { ConflictError } from "@/lib/errors";
import { check, maybe, must, rows, serviceClient } from "./client";
import {
  PAYDAY_ALLOCATION_RULE_COLUMNS,
  PAYDAY_ALLOCATION_RULE_UNIT_COLUMNS,
  type PaydayAllocationRuleRow,
  type PaydayAllocationRuleUnitRow,
  type PaydayAllocationUnitScope,
} from "./types";

export type AllocationRuleWithUnits = PaydayAllocationRuleRow & { units: string[] };

function withUnits(
  rules: PaydayAllocationRuleRow[],
  unitRows: PaydayAllocationRuleUnitRow[],
): AllocationRuleWithUnits[] {
  const byRule = new Map<string, string[]>();
  for (const u of unitRows) {
    const list = byRule.get(u.rule_id) ?? [];
    list.push(u.unit);
    byRule.set(u.rule_id, list);
  }
  return rules.map((r) => ({ ...r, units: byRule.get(r.id) ?? [] }));
}

/** All rules for a paying treasury, sorted for display and apply order. */
export async function listAllocationRules(treasuryId: string): Promise<AllocationRuleWithUnits[]> {
  const rules = rows<PaydayAllocationRuleRow>(
    await serviceClient()
      .from("payday_allocation_rules")
      .select(PAYDAY_ALLOCATION_RULE_COLUMNS)
      .eq("treasury_id", treasuryId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    "list allocation rules",
  );
  if (rules.length === 0) return [];
  const unitRows = rows<PaydayAllocationRuleUnitRow>(
    await serviceClient()
      .from("payday_allocation_rule_units")
      .select(PAYDAY_ALLOCATION_RULE_UNIT_COLUMNS)
      .in("rule_id", rules.map((r) => r.id)),
    "list allocation rule units",
  );
  return withUnits(rules, unitRows);
}

/** Enabled rules for a Payday build (same order as list). */
export async function loadEnabledAllocationRules(treasuryId: string): Promise<AllocationRuleWithUnits[]> {
  return (await listAllocationRules(treasuryId)).filter((r) => r.enabled);
}

export async function loadAllocationRule(id: string): Promise<AllocationRuleWithUnits | null> {
  const rule = maybe<PaydayAllocationRuleRow>(
    await serviceClient()
      .from("payday_allocation_rules")
      .select(PAYDAY_ALLOCATION_RULE_COLUMNS)
      .eq("id", id)
      .maybeSingle(),
    "load allocation rule",
  );
  if (!rule) return null;
  const unitRows = rows<PaydayAllocationRuleUnitRow>(
    await serviceClient()
      .from("payday_allocation_rule_units")
      .select(PAYDAY_ALLOCATION_RULE_UNIT_COLUMNS)
      .eq("rule_id", id),
    "load allocation rule units",
  );
  return { ...rule, units: unitRows.map((u) => u.unit) };
}

export interface CreateAllocationRuleInput {
  community_id: string;
  treasury_id: string;
  label: string;
  basis_points: number;
  enabled: boolean;
  unit_scope: PaydayAllocationUnitScope;
  recipient_wallet: string | null;
  recipient_treasury_id: string | null;
  sort_order: number;
  units: string[];
  created_by: string;
}

export async function createAllocationRule(input: CreateAllocationRuleInput): Promise<AllocationRuleWithUnits> {
  const existing = rows<{ id: string }>(
    await serviceClient()
      .from("payday_allocation_rules")
      .select("id")
      .eq("treasury_id", input.treasury_id),
    "count allocation rules",
  );
  if (existing.length >= MAX_PAYDAY_ALLOCATION_RULES) {
    throw new ConflictError(`A treasury can have at most ${MAX_PAYDAY_ALLOCATION_RULES} allocation rules`);
  }
  if (input.unit_scope === "selected" && input.units.length === 0) {
    throw new ConflictError("Select at least one token for a selected-scope rule");
  }
  const rule = must<PaydayAllocationRuleRow>(
    await serviceClient()
      .from("payday_allocation_rules")
      .insert({
        community_id: input.community_id,
        treasury_id: input.treasury_id,
        label: input.label,
        basis_points: input.basis_points,
        enabled: input.enabled,
        unit_scope: input.unit_scope,
        recipient_wallet: input.recipient_wallet,
        recipient_treasury_id: input.recipient_treasury_id,
        sort_order: input.sort_order,
        created_by: input.created_by,
      })
      .select(PAYDAY_ALLOCATION_RULE_COLUMNS)
      .single(),
    "create allocation rule",
  );
  if (input.unit_scope === "selected" && input.units.length > 0) {
    check(
      await serviceClient()
        .from("payday_allocation_rule_units")
        .insert(input.units.map((unit) => ({ rule_id: rule.id, unit }))),
      "insert allocation rule units",
    );
  }
  return { ...rule, units: input.unit_scope === "selected" ? input.units : [] };
}

export interface UpdateAllocationRuleInput {
  label: string;
  basis_points: number;
  enabled: boolean;
  unit_scope: PaydayAllocationUnitScope;
  recipient_wallet: string | null;
  recipient_treasury_id: string | null;
  sort_order: number;
  units: string[];
}

export async function updateAllocationRule(
  id: string,
  input: UpdateAllocationRuleInput,
): Promise<AllocationRuleWithUnits> {
  if (input.unit_scope === "selected" && input.units.length === 0) {
    throw new ConflictError("Select at least one token for a selected-scope rule");
  }
  const rule = must<PaydayAllocationRuleRow>(
    await serviceClient()
      .from("payday_allocation_rules")
      .update({
        label: input.label,
        basis_points: input.basis_points,
        enabled: input.enabled,
        unit_scope: input.unit_scope,
        recipient_wallet: input.recipient_wallet,
        recipient_treasury_id: input.recipient_treasury_id,
        sort_order: input.sort_order,
      })
      .eq("id", id)
      .select(PAYDAY_ALLOCATION_RULE_COLUMNS)
      .single(),
    "update allocation rule",
  );
  check(
    await serviceClient().from("payday_allocation_rule_units").delete().eq("rule_id", id),
    "clear allocation rule units",
  );
  if (input.unit_scope === "selected" && input.units.length > 0) {
    check(
      await serviceClient()
        .from("payday_allocation_rule_units")
        .insert(input.units.map((unit) => ({ rule_id: id, unit }))),
      "replace allocation rule units",
    );
  }
  return { ...rule, units: input.unit_scope === "selected" ? input.units : [] };
}

export async function deleteAllocationRule(id: string): Promise<void> {
  check(
    await serviceClient().from("payday_allocation_rules").delete().eq("id", id),
    "delete allocation rule",
  );
}
