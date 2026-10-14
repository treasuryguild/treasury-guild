"use client";

import { apiFetch } from "@/lib/api/client";
import type { IpfsGatewayResponse } from "@/lib/api/types";
import { useAsyncData } from "./useAsyncData";

/** The public IPFS gateway host used for previews (null until loaded). */
export function useIpfsGateway(): string | null {
  const { data } = useAsyncData("ipfs-gateway", () =>
    apiFetch<IpfsGatewayResponse>("/api/ipfs/gateway"),
  );
  return data?.gateway ?? null;
}
