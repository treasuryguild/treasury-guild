// Where a recorded copy can be read (proposal_document_copies.locator →
// public URL), client-safe so the proposal page can link a copy without a
// round trip. The server-side adapters (ipfs.ts, github.ts) build their URLs
// through this same function, so the two never drift.
import type { DocumentStoreName } from "@/lib/db/types";
import { ipfsUrl } from "@/lib/ipfs";

export interface StoreHosts {
  /** The IPFS gateway host (PINATA_GATEWAY; the browser reads it from /api/ipfs/gateway). */
  ipfsGateway: string;
  /**
   * GitHub archive full names keyed by repository id (string), for locators
   * of the form `{repoId}/{blobSha}` (migration 0067).
   */
  githubFullNameByRepoId?: Record<string, string>;
}

export const STORE_LABELS: Record<DocumentStoreName, string> = {
  ipfs: "IPFS",
  github: "GitHub",
};

/** Parse `{repoId}/{blobSha}`; null when malformed (client-safe, no crypto). */
export function parseGithubLocator(locator: string): { repoId: number; blobSha: string } | null {
  const slash = locator.indexOf("/");
  if (slash <= 0) return null;
  const repoId = Number(locator.slice(0, slash));
  const blobSha = locator.slice(slash + 1);
  if (!Number.isInteger(repoId) || repoId <= 0 || !/^[0-9a-f]{40}$/.test(blobSha)) return null;
  return { repoId, blobSha };
}

export function copyUrl(store: DocumentStoreName, locator: string, hosts: StoreHosts): string {
  switch (store) {
    case "ipfs":
      return ipfsUrl(hosts.ipfsGateway, locator);
    case "github": {
      const parsed = parseGithubLocator(locator);
      const fullName = parsed && hosts.githubFullNameByRepoId?.[String(parsed.repoId)];
      if (!parsed || !fullName) {
        // Still a navigable fallback when the archive name is not loaded yet.
        return `https://github.com`;
      }
      return `https://raw.githubusercontent.com/${fullName}/HEAD/tallies/${parsed.blobSha}.json`;
    }
  }
}
