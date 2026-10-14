"use client";

// Poll /api/chain/tx-status for a submitted tx so an open signing page sees
// it land on-chain without a manual refresh. The hash alone does not say
// which chain to ask, so the treasury's network travels with it.
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { TxStatusResponse } from "@/lib/api/types";
import type { Network } from "@/lib/config";

const POLL_MS = 30_000;

export function useTxStatusPoll(
  txHash: string | null,
  network: Network,
  enabled: boolean,
): TxStatusResponse | null {
  const [status, setStatus] = useState<TxStatusResponse | null>(null);

  useEffect(() => {
    if (!enabled || !txHash) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await apiFetch<TxStatusResponse>("/api/chain/tx-status", {
          query: { hash: txHash, network: String(network) },
        });
        if (cancelled) return;
        setStatus(next);
        if (next.onChain) return;
      } catch {
        // transient: try again next round
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [txHash, network, enabled]);

  return status;
}
