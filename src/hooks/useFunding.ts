"use client";

// A community's funding sources, their commitments and schedule periods, and
// the inflows tied to them. Members read all of it through RLS.
import { browserClient } from "@/lib/supabase/browser";
import {
  FUNDING_COMMITMENT_COLUMNS, FUNDING_PERIOD_COLUMNS, FUNDING_SOURCE_COLUMNS, type FundingCommitmentRow,
  type FundingPeriodRow, type FundingSourceRow, type IncomingTxRow,
} from "@/lib/db/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

export interface FundingData {
  sources: FundingSourceRow[];
  commitments: FundingCommitmentRow[];
  periods: FundingPeriodRow[];
  inflows: Pick<IncomingTxRow, "tx_hash" | "treasury_id" | "amount_lovelace" | "assets" | "block_time" | "funding_source_id" | "funding_commitment_id">[];
}

export function useFunding(communityId: string | null | undefined, treasuryIds: readonly string[]): AsyncData<FundingData> {
  const key = communityId ? `${communityId}:${treasuryIds.join(",")}` : null;
  return useAsyncData(key, async () => {
    const db = browserClient();
    const [sources, commitments] = await Promise.all([
      db.from("funding_sources").select(FUNDING_SOURCE_COLUMNS).eq("community_id", communityId).order("name"),
      db.from("funding_commitments").select(FUNDING_COMMITMENT_COLUMNS).eq("community_id", communityId).order("created_at"),
    ]);
    if (sources.error) throw new Error(sources.error.message);
    if (commitments.error) throw new Error(commitments.error.message);
    const commitmentRows = (commitments.data ?? []) as FundingCommitmentRow[];
    const scheduleIds = commitmentRows.filter((c) => c.kind === "schedule").map((c) => c.id);
    const [periods, inflows] = await Promise.all([
      scheduleIds.length > 0
        ? db.from("funding_commitment_periods").select(FUNDING_PERIOD_COLUMNS).in("commitment_id", scheduleIds).order("starts_on")
        : Promise.resolve({ data: [], error: null }),
      treasuryIds.length > 0
        ? db.from("incoming_txs")
          .select("tx_hash, treasury_id, amount_lovelace, assets, block_time, funding_source_id, funding_commitment_id")
          .in("treasury_id", treasuryIds)
          .not("funding_source_id", "is", null)
          .order("block_time", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (periods.error) throw new Error(periods.error.message);
    if (inflows.error) throw new Error(inflows.error.message);
    return {
      sources: (sources.data ?? []) as FundingSourceRow[],
      commitments: commitmentRows,
      periods: (periods.data ?? []) as FundingPeriodRow[],
      inflows: (inflows.data ?? []) as FundingData["inflows"],
    };
  });
}
