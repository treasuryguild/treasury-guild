"use client";

// On-visit chain sync for the Treasury and Incoming pages. Fires once per
// visit as soon as the community id is known and never blocks rendering: the
// page shows its database rows immediately and `onSynced` reloads them when
// the server actually polled something. Failures are soft (status text only).
//   const sync = useChainSync(community?.id, txs.reload);
//   <ChainSyncStatus {...sync} />
import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ChainSyncResponse } from "@/lib/api/types";
import { useAsyncData } from "./useAsyncData";

export interface ChainSyncState {
  checking: boolean;
  lastSyncedAt: string | null;
  error: string | null;
}

export function useChainSync(
  communityId: string | null | undefined,
  onSynced: () => void,
): ChainSyncState {
  const sync = useAsyncData(communityId, () =>
    apiFetch<ChainSyncResponse>("/api/treasury/sync", {
      body: { communityId },
    }),
  );

  const onSyncedRef = useRef(onSynced);
  useEffect(() => {
    onSyncedRef.current = onSynced;
  });
  const data = sync.data;
  useEffect(() => {
    if (data && data.polled.length > 0) onSyncedRef.current();
  }, [data]);

  return {
    checking: sync.loading,
    lastSyncedAt: data?.lastSyncedAt ?? null,
    error: sync.error,
  };
}
