"use client";

import { PayState } from "@/lib/constants";
import { PAYABLE_TASK_COLUMNS, type PayableTask } from "@/lib/payday/types";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncData, type AsyncData } from "./useAsyncData";

/** Payable tasks across the community's workgroups. */
export function usePayableTasks(
  communityId: string | null | undefined,
): AsyncData<PayableTask[]> {
  return useAsyncData(communityId, async () => {
    const { data, error } = await browserClient()
      .from("tasks")
      .select(PAYABLE_TASK_COLUMNS)
      .eq("pay_state", PayState.Payable)
      .is("archived_at", null)
      .eq("workgroup.community_id", communityId)
      .is("workgroup.archived_at", null);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as PayableTask[];
  });
}
