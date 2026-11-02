"use client";

import { apiFetch } from "@/lib/api/client";
import type { AllocationRuleResponse, AllocationRulesListResponse } from "@/lib/api/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

/** Payday allocation rules for a paying treasury (member-readable). */
export function useAllocationRules(
  treasuryId: string | null | undefined,
): AsyncData<AllocationRuleResponse[]> {
  return useAsyncData(treasuryId, async () => {
    const res = await apiFetch<AllocationRulesListResponse>(
      `/api/treasury/allocation-rules?treasuryId=${encodeURIComponent(treasuryId!)}`,
    );
    return res.rules;
  });
}
