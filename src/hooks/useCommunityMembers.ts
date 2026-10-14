"use client";

import { browserClient } from "@/lib/supabase/browser";
import {
  MEMBER_WITH_CONTRIBUTOR_COLUMNS,
  type MemberWithContributor,
} from "@/lib/db/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

/** Community members with their contributor profile, oldest first. */
export function useCommunityMembers(
  communityId: string | null | undefined,
): AsyncData<MemberWithContributor[]> {
  return useAsyncData(communityId, async () => {
    const { data } = await browserClient()
      .from("community_members")
      .select(MEMBER_WITH_CONTRIBUTOR_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at");
    return (data ?? []) as unknown as MemberWithContributor[];
  });
}
