"use client";

// A community's funding sources, commitments, schedule periods, and the
// inflows tied to them (chain + previous-wallet receipts) via the overview API.
import { apiFetch } from "@/lib/api/client";
import type { FundingOverview } from "@/lib/db/funding";
import { useAsyncData, type AsyncData } from "./useAsyncData";

export type FundingData = FundingOverview;

export function useFunding(communityId: string | null | undefined, _treasuryIds: readonly string[]): AsyncData<FundingData> {
  return useAsyncData(communityId ?? null, () =>
    apiFetch<FundingData>("/api/funding/overview", { query: { communityId: communityId! } }));
}
