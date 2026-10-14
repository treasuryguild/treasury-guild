// A document store: somewhere outside the database a frozen document can be
// published to, behind one interface so a second store is one more adapter
// (src/lib/storage/index.ts) and copies in an old store keep resolving. The
// database copy stays the source; a store holds replicas that the on-chain
// hash proves. Client-safe types; the adapters are server-only.

import type { DocumentStoreName } from "@/lib/db/types";

export interface DocumentStore {
  name: DocumentStoreName;
  /** Publish the exact bytes under `filename`; the locator finds them again (for IPFS, the bare CID). */
  put(bytes: Uint8Array, filename: string, tags: Record<string, string>): Promise<string>;
  /** A public URL for a locator. */
  url(locator: string): string;
  /** Whether the copy still resolves (a pin dropped, a gateway that lost it). */
  resolves(locator: string): Promise<boolean>;
}
