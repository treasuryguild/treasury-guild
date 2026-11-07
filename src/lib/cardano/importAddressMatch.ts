import { shortAddress } from "@/lib/format";

/** One key-hash slot of an import draft (claimed or empty). */
export interface ImportMatchSlot {
  keyHash: string;
  address: string | null;
}

/** A pasted payment address with its derived payment key hash. */
export interface ImportMatchAddress {
  address: string;
  keyHash: string;
}

export interface ImportAddressMatch {
  /** New fills only; empty when any problem was found (all-or-nothing). */
  assignments: { keyHash: string; address: string }[];
  problems: string[];
}

/**
 * Match pasted payment addresses to import-draft slots by payment key hash.
 * Order of addresses does not matter. Same address on an already-claimed slot
 * is a no-op; a different address for that key, a key not in the script, or a
 * duplicate in the paste list is a problem. Callers apply nothing when
 * `problems` is non-empty.
 */
export function matchImportAddresses(
  slots: ImportMatchSlot[],
  addresses: ImportMatchAddress[],
): ImportAddressMatch {
  const byKey = new Map(slots.map((s) => [s.keyHash.toLowerCase(), s]));
  const seenKeys = new Set<string>();
  const problems: string[] = [];
  const assignments: { keyHash: string; address: string }[] = [];

  for (const row of addresses) {
    const keyHash = row.keyHash.toLowerCase();
    const label = shortAddress(row.address);

    if (seenKeys.has(keyHash)) {
      problems.push(`${label} is listed more than once`);
      continue;
    }
    seenKeys.add(keyHash);

    const slot = byKey.get(keyHash);
    if (!slot) {
      problems.push(`${label} is not a signer of this script`);
      continue;
    }
    if (slot.address !== null) {
      if (slot.address === row.address) continue;
      problems.push(`${label} conflicts with an already claimed signer`);
      continue;
    }
    assignments.push({ keyHash: slot.keyHash, address: row.address });
  }

  if (problems.length > 0) return { assignments: [], problems };
  return { assignments, problems: [] };
}
