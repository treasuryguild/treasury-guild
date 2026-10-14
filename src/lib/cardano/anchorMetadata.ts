// On-chain proposal anchors (label 190002): the one home for that label. The
// record anchors a proposal's hashes so a decision is evident on-chain
// (docs/onchain-anchoring-estimate.md, phase 3): the content and rules hashes
// when it is proposed, the electorate hash when voting opens, and the final
// state with the frozen tally's hash, counts and outside copy when it closes.
// 190002 is not in the CIP-10 registry, like 190001.
//
// Nothing member-written goes on-chain: the record names the community by
// slug and carries numbers, states and hashes, never a title, a body or a
// wallet. Every string stays under the 64-byte metadatum cap (a hash is 64
// hex characters, a CIDv1 is 59).
//
// The phase-0 groundwork test record ({v, src, c, test: 1}) is still a valid
// label-190002 value (the preprod test transaction carries it); the strict
// parser returns null for it and the transaction page shows it raw.

import { AnchorStep } from "@/lib/constants";
import { isRecord } from "@/lib/guards";
import { MAX_METADATA_JSON_BYTES, METADATA_SRC, metadataJsonBytes, truncateUtf8 } from "./metadata";

export const ANCHOR_METADATA_LABEL = "190002";
export const ANCHOR_METADATA_VERSION = 1;

const HASH_RE = /^[0-9a-f]{64}$/;

/** [proposal number, "proposed", content hash, rules hash] */
export type ProposedAnchorEntry = [n: number, step: "proposed", contentHash: string, rulesHash: string];
/** [proposal number, "opened", electorate hash] */
export type OpenedAnchorEntry = [n: number, step: "opened", electorateHash: string];
/** [voters who could vote, ballots cast, [[choice, count], …]] */
export type AnchorTallyCounts = [electorate: number, ballots: number, counts: [choice: string, count: number][]];
/** [store name, locator], e.g. ["ipfs", <bare CID>] */
export type AnchorLocator = [store: string, locator: string];
/**
 * [proposal number, "closed", final state] for a proposal that never reached
 * voting; with the frozen tally's hash and counts once it did, and the copy
 * in the community's chosen store when one exists.
 */
export type ClosedAnchorEntry =
  | [n: number, step: "closed", state: string]
  | [n: number, step: "closed", state: string, tallyHash: string, counts: AnchorTallyCounts]
  | [n: number, step: "closed", state: string, tallyHash: string, counts: AnchorTallyCounts, copy: AnchorLocator];

export type AnchorEntry = ProposedAnchorEntry | OpenedAnchorEntry | ClosedAnchorEntry;

export interface AnchorMetadata {
  v: typeof ANCHOR_METADATA_VERSION;
  src: typeof METADATA_SRC;
  /** Community slug. */
  c: string;
  /** One entry per (proposal, step), proposals in number order, steps in lifecycle order. */
  a: AnchorEntry[];
}

/** The groundwork test record: no proposal, just the version, source and slug (phase 0). */
export interface AnchorTestMetadata {
  v: 1;
  src: "treasury-guild";
  c: string;
  /** Marks the record as the phase-0 test; the real record has `a` (anchors) instead. */
  test: 1;
}

export function buildAnchorTestMetadata(communitySlug: string): AnchorTestMetadata {
  return { v: ANCHOR_METADATA_VERSION, src: METADATA_SRC, c: communitySlug, test: 1 };
}

/** Whether a decoded label-190002 value is a Treasury Guild anchor record (any version, test record included). */
export function isAnchorRecord(value: unknown): value is { v: number; src: "treasury-guild"; c: string } {
  return isRecord(value) && typeof value.v === "number" && value.src === METADATA_SRC && typeof value.c === "string";
}

export function buildAnchorMetadata(communitySlug: string, entries: readonly AnchorEntry[]): AnchorMetadata {
  return { v: ANCHOR_METADATA_VERSION, src: METADATA_SRC, c: truncateUtf8(communitySlug), a: [...entries] };
}

const STEP_ORDER: Record<AnchorStep, number> = { proposed: 0, opened: 1, closed: 2 };

/** Proposal number, then lifecycle step: the order a record lists its entries in. */
export function compareAnchorEntries(a: AnchorEntry, b: AnchorEntry): number {
  return a[0] - b[0] || STEP_ORDER[a[1]] - STEP_ORDER[b[1]];
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isHash(v: unknown): v is string {
  return typeof v === "string" && HASH_RE.test(v);
}

function isShortString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 64;
}

function isTallyCounts(v: unknown): v is AnchorTallyCounts {
  return Array.isArray(v) && v.length === 3 && isCount(v[0]) && isCount(v[1]) && Array.isArray(v[2]) &&
    v[2].every((c) => Array.isArray(c) && c.length === 2 && isShortString(c[0]) && isCount(c[1]));
}

function isLocator(v: unknown): v is AnchorLocator {
  return Array.isArray(v) && v.length === 2 && isShortString(v[0]) && isShortString(v[1]);
}

/** A well-formed entry of any step. */
export function isAnchorEntry(e: unknown): e is AnchorEntry {
  if (!Array.isArray(e) || !isPositiveInt(e[0])) return false;
  switch (e[1]) {
    case AnchorStep.Proposed:
      return e.length === 4 && isHash(e[2]) && isHash(e[3]);
    case AnchorStep.Opened:
      return e.length === 3 && isHash(e[2]);
    case AnchorStep.Closed:
      if (!isShortString(e[2])) return false;
      if (e.length === 3) return true;
      if (!isHash(e[3]) || !isTallyCounts(e[4])) return false;
      return e.length === 5 || (e.length === 6 && isLocator(e[5]));
    default:
      return false;
  }
}

/**
 * Narrow a decoded label-190002 datum to a v1 anchor record. It comes from
 * the chain, so any shape is possible: anything that is not a complete record
 * (the test record, another version, a malformed entry) is null.
 */
export function parseAnchorMetadata(value: unknown): AnchorMetadata | null {
  if (!isRecord(value)) return null;
  const m = value;
  if (m.v !== ANCHOR_METADATA_VERSION || m.src !== METADATA_SRC || typeof m.c !== "string") return null;
  if (!Array.isArray(m.a) || !m.a.every(isAnchorEntry)) return null;
  return { v: ANCHOR_METADATA_VERSION, src: METADATA_SRC, c: m.c, a: m.a };
}

/** The proposal numbers a record anchors, each once, ascending (for links). */
export function anchorProposalNumbers(meta: unknown): number[] {
  const parsed = parseAnchorMetadata(meta);
  if (!parsed) return [];
  return [...new Set(parsed.a.map((e) => e[0]))].sort((a, b) => a - b);
}

/**
 * The record carrying as many of `entries` (in order) as fit in `roomBytes`
 * of JSON, and which ones it carries; null when not even the first fits. A
 * payout or payment record has priority over anchors, so the room is what
 * the metadata guard leaves after it; a dedicated anchor transaction has
 * the whole guard.
 */
export function fitAnchorEntries<T extends { entry: AnchorEntry }>(
  communitySlug: string,
  entries: readonly T[],
  roomBytes: number = MAX_METADATA_JSON_BYTES,
): { record: AnchorMetadata; carried: T[] } | null {
  const carried: T[] = [];
  for (const candidate of entries) {
    const next = [...carried, candidate];
    if (metadataJsonBytes(buildAnchorMetadata(communitySlug, next.map((c) => c.entry))) > roomBytes) break;
    carried.push(candidate);
  }
  if (carried.length === 0) return null;
  return { record: buildAnchorMetadata(communitySlug, carried.map((c) => c.entry)), carried };
}
