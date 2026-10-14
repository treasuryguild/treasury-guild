"use client";

import { apiFetch } from "@/lib/api/client";
import type { WalletAssetsResponse } from "@/lib/api/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

export function fetchWalletAssets(address: string): Promise<WalletAssetsResponse> {
  return apiFetch<WalletAssetsResponse>("/api/chain/wallet-assets", {
    query: { address },
  });
}

/** Balances + token metadata for one address (via /api/chain/wallet-assets). */
export function useWalletAssets(
  address: string | null | undefined,
): AsyncData<WalletAssetsResponse> {
  return useAsyncData(address, () => fetchWalletAssets(address as string));
}

/** Balances for several addresses, keyed by address; failures are omitted. */
export function useWalletAssetsMany(
  addresses: string[],
): AsyncData<Record<string, WalletAssetsResponse>> {
  const key = addresses.length > 0 ? addresses.join(",") : null;
  return useAsyncData(key, async () => {
    const results = await Promise.allSettled(addresses.map(fetchWalletAssets));
    const out: Record<string, WalletAssetsResponse> = {};
    results.forEach((r, i) => {
      const address = addresses[i];
      if (r.status === "fulfilled" && address) out[address] = r.value;
    });
    return out;
  });
}
