// Where a recorded copy can be read (proposal_document_copies.locator →
// public URL), client-safe so the proposal page can link a copy without a
// round trip. The server-side adapters (ipfs.ts) build their URLs through
// this same function, so the two never drift.
import type { DocumentStoreName } from "@/lib/db/types";
import { ipfsUrl } from "@/lib/ipfs";

export interface StoreHosts {
  /** The IPFS gateway host (PINATA_GATEWAY; the browser reads it from /api/ipfs/gateway). */
  ipfsGateway: string;
}

export const STORE_LABELS: Record<DocumentStoreName, string> = { ipfs: "IPFS" };

export function copyUrl(store: DocumentStoreName, locator: string, hosts: StoreHosts): string {
  switch (store) {
    case "ipfs":
      return ipfsUrl(hosts.ipfsGateway, locator);
  }
}
