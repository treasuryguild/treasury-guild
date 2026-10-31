/**
 * CIP-0146 (label 1854) registration metadata helpers.
 *
 * A treasury is registered on-chain by a transaction carrying metadata under
 * label 1854:
 *   { types: number[], name?, description?, participants?: { [keyHash]: { name } } }
 *
 * Cardano transaction metadata strings are limited to 64 bytes, so long
 * name/description values are chunked into string arrays (reversible),
 * while participant names are truncated (map values can't become arrays
 * without breaking the CIP shape).
 *
 * Participants include every signer group (base, recovery, cosigner) plus
 * base stake (role 2) and DRep (role 3) key hashes — not only the payment
 * keys that MultisigWallet.getJsonMetadata() would list for a plain wallet.
 */

import { SignerGroup } from "@/lib/constants";
import type { TreasuryRow, TreasurySignerRow } from "@/lib/db/types";
import { isRecord } from "@/lib/guards";

export const METADATA_LABEL_1854 = "1854";
export const METADATA_STRING_MAX_BYTES = 64;

export type Label1854Participant = { name: string };

export type Label1854Metadata = {
  types: number[];
  name?: string | string[];
  description?: string | string[];
  participants?: Record<string, Label1854Participant>;
};

export type Label1854LookupItem = {
  tx_hash: string;
  json_metadata?: Label1854Metadata | null;
};

const encoder = new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Split a string into chunks of at most METADATA_STRING_MAX_BYTES UTF-8
 * bytes, never splitting inside a code point. Returns the string itself
 * when it already fits.
 */
export function chunkMetadataString(value: string): string | string[] {
  if (byteLength(value) <= METADATA_STRING_MAX_BYTES) return value;
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = byteLength(char);
    if (currentBytes + charBytes > METADATA_STRING_MAX_BYTES) {
      chunks.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Truncate a string to at most METADATA_STRING_MAX_BYTES UTF-8 bytes. */
export function truncateMetadataString(value: string): string {
  if (byteLength(value) <= METADATA_STRING_MAX_BYTES) return value;
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = byteLength(char);
    if (bytes + charBytes > METADATA_STRING_MAX_BYTES) break;
    out += char;
    bytes += charBytes;
  }
  return out;
}

/** Reassemble a possibly-chunked metadata string for display. */
export function joinMetadataString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string").join("");
  }
  return "";
}

/** Parse a label-1854 map value into our registration shape (null if invalid). */
export function parseLabel1854Metadata(value: unknown): Label1854Metadata | null {
  if (!isRecord(value) || !Array.isArray(value.types)) return null;
  const types = value.types.filter((t): t is number => typeof t === "number");
  if (types.length === 0) return null;
  const participants: Label1854Metadata["participants"] = {};
  if (isRecord(value.participants)) {
    for (const [hash, info] of Object.entries(value.participants)) {
      if (!/^[0-9a-f]{56}$/i.test(hash)) continue;
      participants[hash.toLowerCase()] = {
        name: joinMetadataString(isRecord(info) ? info.name : ""),
      };
    }
  }
  const out: Label1854Metadata = { types };
  const name = joinMetadataString(value.name);
  const description = joinMetadataString(value.description);
  if (name) out.name = value.name as string | string[];
  if (description) out.description = value.description as string | string[];
  if (Object.keys(participants).length > 0) out.participants = participants;
  return out;
}

/** Every key hash that belongs in a CIP-0146 participants map for this treasury. */
export function treasuryParticipantHashes(
  signers: readonly Pick<
    TreasurySignerRow,
    "key_hash" | "stake_key_hash" | "drep_key_hash" | "signer_group"
  >[],
): string[] {
  const hashes = new Set<string>();
  for (const signer of signers) {
    hashes.add(signer.key_hash.toLowerCase());
    if (signer.signer_group === SignerGroup.Base) {
      if (signer.stake_key_hash) hashes.add(signer.stake_key_hash.toLowerCase());
      if (signer.drep_key_hash) hashes.add(signer.drep_key_hash.toLowerCase());
    }
  }
  return [...hashes];
}

/**
 * Build the label-1854 payload for a treasury, applying the 64-byte
 * metadata string limits. Empty name/description are omitted (both are
 * optional per CIP-0146; `types` is the only required field).
 */
export function buildTreasuryLabel1854Metadata(
  treasury: Pick<TreasuryRow, "name">,
  signers: readonly Pick<
    TreasurySignerRow,
    "key_hash" | "stake_key_hash" | "drep_key_hash" | "display_name" | "signer_group"
  >[],
  description = "",
): Label1854Metadata {
  const types = new Set<number>([0]);
  const participants: Record<string, Label1854Participant> = {};

  for (const signer of signers) {
    const name = truncateMetadataString(signer.display_name ?? "");
    participants[signer.key_hash.toLowerCase()] = { name };
    if (signer.signer_group === SignerGroup.Base) {
      if (signer.stake_key_hash) {
        types.add(2);
        participants[signer.stake_key_hash.toLowerCase()] = { name };
      }
      if (signer.drep_key_hash) {
        types.add(3);
        participants[signer.drep_key_hash.toLowerCase()] = { name };
      }
    }
  }

  const payload: Label1854Metadata = {
    types: [...types].sort((a, b) => a - b),
    participants,
  };
  if (treasury.name) payload.name = chunkMetadataString(treasury.name);
  if (description) payload.description = chunkMetadataString(description);
  return payload;
}

function participantKeySet(item: Label1854LookupItem): Set<string> | null {
  const participants = item.json_metadata?.participants;
  if (!participants || typeof participants !== "object") return null;
  const keys = Object.keys(participants);
  if (keys.length === 0) return null;
  return new Set(keys.map((k) => k.toLowerCase()));
}

/**
 * True when a lookup item's participant key hashes exactly equal the
 * given set (case-insensitive). The lookup endpoint matches on ANY
 * shared hash, so a signer who belongs to several registered wallets
 * gets items for all of them — exact-set equality identifies THIS
 * wallet's registration.
 */
export function participantsMatchExactly(
  item: Label1854LookupItem,
  keyHashes: string[],
): boolean {
  const onChain = participantKeySet(item);
  if (!onChain) return false;
  const expected = new Set(keyHashes.map((k) => k.toLowerCase()));
  if (onChain.size !== expected.size) return false;
  for (const hash of expected) {
    if (!onChain.has(hash)) return false;
  }
  return true;
}

/**
 * True when every given hash is a participant of the item
 * (case-insensitive). Used for policy lookups: a native script's sig
 * hashes must all appear in the registration's participants (which may
 * additionally list stake/dRep hashes) for the registration to be that
 * script's wallet.
 */
export function participantsInclude(
  item: Label1854LookupItem,
  keyHashes: string[],
): boolean {
  const onChain = participantKeySet(item);
  if (!onChain || keyHashes.length === 0) return false;
  return keyHashes.every((hash) => onChain.has(hash.toLowerCase()));
}

/**
 * True when an on-chain registration's metadata already reflects the
 * treasury's current metadata (name, description, participant names and
 * types) — used to decide between "up to date" and "update available".
 */
export function isRegistrationUpToDate(
  item: Label1854LookupItem,
  treasury: Pick<TreasuryRow, "name">,
  signers: readonly Pick<
    TreasurySignerRow,
    "key_hash" | "stake_key_hash" | "drep_key_hash" | "display_name" | "signer_group"
  >[],
  description = "",
): boolean {
  const onChain = item.json_metadata;
  if (!onChain) return false;
  const current = buildTreasuryLabel1854Metadata(treasury, signers, description);

  if (joinMetadataString(onChain.name) !== joinMetadataString(current.name)) {
    return false;
  }
  if (
    joinMetadataString(onChain.description) !==
    joinMetadataString(current.description)
  ) {
    return false;
  }

  const onChainTypes = [...(onChain.types ?? [])].sort((a, b) => a - b);
  const currentTypes = [...current.types].sort((a, b) => a - b);
  if (JSON.stringify(onChainTypes) !== JSON.stringify(currentTypes)) {
    return false;
  }

  const currentParticipants = current.participants ?? {};
  const onChainParticipants = onChain.participants ?? {};
  const currentKeys = Object.keys(currentParticipants);
  if (currentKeys.length !== Object.keys(onChainParticipants).length) {
    return false;
  }
  for (const keyHash of currentKeys) {
    const onChainEntry = Object.entries(onChainParticipants).find(
      ([k]) => k.toLowerCase() === keyHash.toLowerCase(),
    );
    if (!onChainEntry) return false;
    if (
      joinMetadataString(onChainEntry[1]?.name) !==
      currentParticipants[keyHash]!.name
    ) {
      return false;
    }
  }
  return true;
}
