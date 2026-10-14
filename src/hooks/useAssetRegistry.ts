"use client";

import {
  COMMUNITY_ASSET_COLUMNS,
  registryFromRows,
  type CommunityAssetColumns,
} from "@/lib/assetRegistry";
import type { AssetDef } from "@/lib/assets";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncData, type AsyncData } from "./useAsyncData";

/** Persisted field-name -> unit mappings for the community. */
export function useAssetRegistry(
  communityId: string | null | undefined,
): AsyncData<AssetDef[]> {
  return useAsyncData(communityId, async () => {
    const { data } = await browserClient()
      .from("community_assets")
      .select(COMMUNITY_ASSET_COLUMNS)
      .eq("community_id", communityId);
    return registryFromRows((data ?? []) as CommunityAssetColumns[]);
  });
}
