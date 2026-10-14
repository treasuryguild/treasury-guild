"use client";

// On-chain payouts and payments the chain import could not finish on its own
// (external_txs rows held as 'blocked', or dismissed as 'ignored'). Members
// can read external_txs, so this is a plain browser query; the actions go
// through /api/chain-import/*.
import { ChainImportStatus } from "@/lib/constants";
import { EXTERNAL_TX_COLUMNS, type ExternalTxRow } from "@/lib/db/types";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncData, type AsyncData } from "./useAsyncData";

export function useChainImportQueue(treasuryIds: readonly string[]): AsyncData<ExternalTxRow[]> {
  return useAsyncData(treasuryIds.length > 0 ? treasuryIds.join(",") : null, async () => {
    const { data, error } = await browserClient()
      .from("external_txs")
      .select(EXTERNAL_TX_COLUMNS)
      .in("treasury_id", [...treasuryIds])
      .in("import_status", [ChainImportStatus.Blocked, ChainImportStatus.Ignored])
      .order("block_time", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as ExternalTxRow[];
  });
}
