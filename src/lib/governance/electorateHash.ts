// The electorate hash (migration 0060): sha256 hex over one line per voter,
// "<wallet> <0|1>" (1 = recused), sorted by wallet in byte order, joined by
// "\n" with no trailing newline. open_proposal_voting computes the same in
// SQL and stores it on the proposal; every ballot signs it, so the voter
// list cannot change once a ballot exists, and the "opened" anchor carries
// it. Client-safe (WebCrypto), so the tally checker can recompute it in the
// browser from the document's electorate list.
import { bytesToHex } from "@/lib/cardano/cip25";

export interface ElectorateSeat {
  wallet: string;
  recused: boolean;
}

/** The exact text hashed; exported for the tests that pin it against the SQL. */
export function electorateText(voters: readonly ElectorateSeat[]): string {
  return [...voters]
    // Byte order, like `collate "C"`: never localeCompare, which depends on the locale.
    .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0))
    .map((v) => `${v.wallet} ${v.recused ? 1 : 0}`)
    .join("\n");
}

export async function electorateHash(voters: readonly ElectorateSeat[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(electorateText(voters)));
  return bytesToHex(new Uint8Array(digest));
}
