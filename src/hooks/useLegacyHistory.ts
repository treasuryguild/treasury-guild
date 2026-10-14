"use client";

import { apiFetch } from "@/lib/api/client";
import type { LegacyHistoryOverview, LegacyRowsResponse } from "@/lib/api/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

/** The community's previous wallets and history imports (admins only). */
export function useLegacyHistory(communityId: string | null | undefined): AsyncData<LegacyHistoryOverview> {
  return useAsyncData(communityId ?? null, () =>
    apiFetch<LegacyHistoryOverview>("/api/legacy-history", { query: { communityId: communityId! } }));
}

/** One page of an import's lines; `version` re-reads after a change. */
export function useLegacyRows(
  communityId: string | null | undefined,
  importId: string | null,
  offset: number,
  version: number,
): AsyncData<LegacyRowsResponse> {
  return useAsyncData(communityId && importId ? `${communityId}:${importId}:${offset}:${version}` : null, () =>
    apiFetch<LegacyRowsResponse>("/api/legacy-history/rows", {
      query: { communityId: communityId!, importId: importId!, offset },
    }));
}
