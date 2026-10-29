// On-chain payout metadata (label 190001, schema v3) + CIP-20 (674) message
// helpers. Cardano metadatum strings are capped at 64 bytes — every string
// emitted here is enforced against that limit.
//
// v3 shape — compact positional encoding, one entry per recipient output:
//   { v: 3, src: "treasury-guild", c: <community slug>,
//     w: [<workgroup name>, …], b: [<budget period>, …], k: [<asset ticker>, …],
//     p: [ [<output index>, [ [<task number>, <w index>, <b index>, [<amount>, …]], … ]], … ] }
// Workgroup names, budget periods and asset tickers are interned in the
// top-level lists so each task references them by a one-byte index. A budget
// period is "YYYY-MM" for a workgroup budgeted by month or "YYYY-Qn" for one
// budgeted by quarter, so the record reads without the database. A task's
// amounts array is aligned to `k`: exact decimal strings in the asset's
// display units ("5" ADA, "3500" GVTT — scaled with the decimals the token
// metadata declares), "" where the task pays none of that asset, trailing ""
// trimmed. (Cardano metadata has no null type.) Amounts are the task
// bounties only — the min-UTxO lovelace the ledger forces onto token outputs
// is visible in the tx body and deliberately not repeated. The output index
// ties an entry to the tx body output that pays it; the network is implied
// by the chain the tx sits on.
//
// Optional `g` (decisions): the proposals that authorised the payout,
//   g: [ [<proposal number>, <content hash>, [<task number>, …]], … ]
// one entry per cited proposal (a task proposal, or the budget proposal that
// set the period's budget), with the tasks that cite it; a task appears
// under every proposal it cites. Omitted when nothing is cited. Still v3:
// readers ignore a key they do not know, and the task entry keeps its four
// elements.

import { formatQuantity } from "@/lib/assets";
import { MAX_TASK_NUMBER } from "@/lib/constants";
import { isRecord, isStringArray } from "@/lib/guards";

export const PAYOUT_METADATA_LABEL = "190001";
export const CIP20_LABEL = "674";
export const PAYOUT_METADATA_VERSION = 3;
/** The `src` of every Treasury Guild label-190001 record (payouts and payments). */
export const METADATA_SRC = "treasury-guild";

/** Cardano metadatum string cap (bytes). */
export const MAX_METADATUM_STR_BYTES = 64;
const MAX_STR_BYTES = MAX_METADATUM_STR_BYTES;
/** Tickers share community_assets' 32-byte field-name cap. */
export const MAX_TICKER_BYTES = 32;
// CIP-20 convention chunks message lines at 63 chars.
const MSG_CHUNK = 63;
/**
 * JSON size guard for a label-190001 record. CBOR is never larger than the
 * JSON rendering, and the whole tx must stay under the 16 384-byte ledger cap
 * with room for inputs, outputs and witnesses.
 */
export const MAX_METADATA_JSON_BYTES = 10_000;
export const MAX_PAYOUT_METADATA_JSON_BYTES = MAX_METADATA_JSON_BYTES;

const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Truncate a string to at most `max` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(s: string, max: number = MAX_STR_BYTES): string {
  if (byteLength(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (byteLength(out + ch) > max) break;
    out += ch;
  }
  return out;
}

/**
 * One paid task: community task number, index into `w`, index into `b`, and
 * amounts aligned to `k` ("" = none of that asset, trailing "" trimmed).
 */
export type PayoutMetadataTask = [i: number, w: number, b: number, x: string[]];

/** One recipient: index of its output in the tx body, then its tasks. */
export type PayoutMetadataEntry = [o: number, t: PayoutMetadataTask[]];

/** One cited proposal: its number, its content hash (sha256 hex) and the tasks citing it. */
export type PayoutCitation = [n: number, h: string, tasks: number[]];

export interface PayoutMetadata {
  v: typeof PAYOUT_METADATA_VERSION;
  src: typeof METADATA_SRC;
  /** Community slug (≤64 bytes enforced at slug creation) */
  c: string;
  /** Workgroup names, first-seen order. */
  w: string[];
  /** Budget periods ("YYYY-MM" or "YYYY-Qn"), first-seen order. */
  b: string[];
  /** Asset tickers ("ADA" included when paid), first-seen order. */
  k: string[];
  p: PayoutMetadataEntry[];
  /** The decisions behind the payout, by proposal number; absent when none is cited. */
  g?: PayoutCitation[];
}

/** A proposal a spend cites: its number and the content hash every ballot signed. */
export interface Citation {
  number: number;
  contentHash: string;
}

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

function isIndex(v: unknown, length: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < length;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** A well-formed `g` entry: positive number, 64-hex hash, positive task numbers. */
export function isPayoutCitation(g: unknown): g is PayoutCitation {
  return Array.isArray(g) && g.length === 3 && isPositiveInt(g[0]) &&
    typeof g[1] === "string" && CONTENT_HASH_RE.test(g[1]) &&
    Array.isArray(g[2]) && g[2].every(isPositiveInt);
}

/** A well-formed payment citation: [number, hash]. */
export function isPaymentCitation(g: unknown): g is [number, string] {
  return Array.isArray(g) && g.length === 2 && isPositiveInt(g[0]) &&
    typeof g[1] === "string" && CONTENT_HASH_RE.test(g[1]);
}

/** Citations sorted by number, one per proposal (the first hash seen wins). */
export function dedupeCitations(citations: readonly Citation[]): Citation[] {
  const byNumber = new Map<number, Citation>();
  for (const c of citations) if (!byNumber.has(c.number)) byNumber.set(c.number, c);
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * Narrow a decoded label-190001 datum to a v3 Treasury Guild payout record. It
 * comes from the chain, so any shape is possible: anything that is not a
 * complete record (wrong version or source, an index outside its list, more
 * amounts than tickers) is null. The one reader of the payout shape: the
 * transaction page renders from it and the chain import rebuilds rows from it.
 */
export function parsePayoutMetadata(value: unknown): PayoutMetadata | null {
  if (!isRecord(value)) return null;
  const m = value;
  if (m.v !== PAYOUT_METADATA_VERSION || m.src !== METADATA_SRC) return null;
  if (typeof m.c !== "string" || !isStringArray(m.w) || !isStringArray(m.b) || !isStringArray(m.k)) {
    return null;
  }
  if (!Array.isArray(m.p)) return null;
  const { w, b, k } = m;
  const isTask = (t: unknown): t is PayoutMetadataTask =>
    Array.isArray(t) &&
    t.length === 4 &&
    typeof t[0] === "number" &&
    Number.isInteger(t[0]) &&
    t[0] > 0 &&
    t[0] <= MAX_TASK_NUMBER &&
    isIndex(t[1], w.length) &&
    isIndex(t[2], b.length) &&
    isStringArray(t[3]) &&
    t[3].length <= k.length;
  const isEntry = (e: unknown): e is PayoutMetadataEntry =>
    Array.isArray(e) &&
    e.length === 2 &&
    typeof e[0] === "number" &&
    Number.isInteger(e[0]) &&
    e[0] >= 0 &&
    Array.isArray(e[1]) &&
    e[1].every(isTask);
  if (!m.p.every(isEntry)) return null;
  if (m.g !== undefined && !(Array.isArray(m.g) && m.g.every(isPayoutCitation))) return null;
  return {
    v: PAYOUT_METADATA_VERSION, src: METADATA_SRC, c: m.c, w, b, k, p: m.p,
    ...(m.g !== undefined ? { g: m.g as PayoutCitation[] } : {}),
  };
}

/** The proposal numbers a payout or payment record cites (`g`), for linking; [] when none. */
export function citedProposalNumbers(meta: unknown): number[] {
  if (!isRecord(meta) || !Array.isArray(meta.g)) return [];
  const numbers = new Set<number>();
  for (const g of meta.g) if (Array.isArray(g) && isPositiveInt(g[0])) numbers.add(g[0]);
  return [...numbers].sort((a, b) => a - b);
}

/** The subset of a payout record the treasury activity list shows. */
export interface PayoutMetaView {
  workgroups: string[];
  taskNumbers: number[];
  outputs: number;
}

/**
 * Read label-190001 metadata leniently for display: unlike
 * `parsePayoutMetadata`, which needs a complete record, this shows whatever
 * it can read. Null unless it looks like a Treasury Guild payout.
 */
export function parsePayoutMeta(meta: unknown): PayoutMetaView | null {
  if (!isRecord(meta)) return null;
  const m = meta;
  if (m.src !== METADATA_SRC || !Array.isArray(m.p)) return null;
  const workgroups = Array.isArray(m.w)
    ? m.w.filter((w): w is string => typeof w === "string")
    : [];
  const numbers = new Set<number>();
  for (const entry of m.p) {
    if (!Array.isArray(entry) || !Array.isArray(entry[1])) continue;
    for (const task of entry[1]) {
      if (Array.isArray(task) && typeof task[0] === "number") numbers.add(task[0]);
    }
  }
  return {
    workgroups,
    taskNumbers: [...numbers].sort((a, b) => a - b),
    outputs: m.p.length,
  };
}

export function addressTail(address: string): string {
  return address.slice(-6);
}

export interface PayoutForMetadata {
  /** Index of the recipient's output in the tx body. */
  outputIndex: number;
  taskNumber: number;
  workgroupName: string;
  /** "YYYY-MM" (monthly workgroup) or "YYYY-Qn" (quarterly workgroup). */
  budgetPeriod: string;
  /**
   * Bounties as on-chain integer quantities plus the decimals the asset
   * declares (ADA is 6; unknown tokens 0, so base units are shown).
   */
  amounts: { ticker: string; quantity: bigint; decimals: number }[];
  /** The proposals this task's payout cites (its own, the period's budget); none when absent. */
  citations?: readonly Citation[];
}

/** A top-level list (`w`, `b`, `k`) that records reference by index. */
export interface InternList {
  values: string[];
  index: Map<string, number>;
}

export function internList(): InternList {
  return { values: [], index: new Map() };
}

/** Intern `value`, returning its index (first-seen order). */
export function intern(list: InternList, value: string): number {
  let i = list.index.get(value);
  if (i === undefined) {
    i = list.values.length;
    list.values.push(value);
    list.index.set(value, i);
  }
  return i;
}

/**
 * One entry's amounts aligned to the ticker list: quantities summed as
 * integers per ticker (interned into `tickers`) and scaled once with
 * `formatQuantity` (exact, no float math); zero quantities are absent, ""
 * fills the gaps and trailing "" is never emitted.
 */
export function alignedAmounts(
  amounts: { ticker: string; quantity: bigint; decimals: number }[],
  tickers: InternList,
): string[] {
  const sums = new Map<number, { quantity: bigint; decimals: number }>();
  for (const a of amounts) {
    if (a.quantity <= 0n) continue;
    const k = intern(tickers, truncateUtf8(a.ticker, MAX_TICKER_BYTES));
    const prev = sums.get(k);
    // The registry maps one unit per ticker, so decimals cannot disagree;
    // if they ever did, the first seen wins rather than mixing scales.
    sums.set(k, {
      quantity: (prev?.quantity ?? 0n) + a.quantity,
      decimals: prev?.decimals ?? a.decimals,
    });
  }
  const width = sums.size > 0 ? Math.max(...sums.keys()) + 1 : 0;
  const x: string[] = Array.from({ length: width }, () => "");
  for (const [k, { quantity, decimals }] of sums) x[k] = formatQuantity(quantity, decimals);
  return x;
}

/**
 * Build the label-190001 metadata object: entries ordered by output index,
 * one task tuple per task, every string ≤64 bytes. Quantities are summed as
 * integers per asset and scaled once with `formatQuantity` (exact, no float
 * math); zero quantities are treated as absent.
 */
export function buildPayoutMetadata(
  communitySlug: string,
  payouts: PayoutForMetadata[],
): PayoutMetadata {
  const workgroups = internList();
  const periods = internList();
  const assets = internList();
  const byOutput = new Map<number, PayoutMetadataEntry>();
  const cited = new Map<number, { hash: string; tasks: Set<number> }>();

  for (const p of payouts) {
    const w = intern(workgroups, truncateUtf8(p.workgroupName));
    const b = intern(periods, truncateUtf8(p.budgetPeriod));

    let entry = byOutput.get(p.outputIndex);
    if (!entry) {
      entry = [p.outputIndex, []];
      byOutput.set(p.outputIndex, entry);
    }
    entry[1].push([p.taskNumber, w, b, alignedAmounts(p.amounts, assets)]);
    for (const c of dedupeCitations(p.citations ?? [])) {
      let g = cited.get(c.number);
      if (!g) {
        g = { hash: c.contentHash, tasks: new Set() };
        cited.set(c.number, g);
      }
      g.tasks.add(p.taskNumber);
    }
  }

  const g: PayoutCitation[] = [...cited.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, { hash, tasks }]) => [number, hash, [...tasks].sort((a, b) => a - b)]);

  return {
    v: PAYOUT_METADATA_VERSION,
    src: METADATA_SRC,
    c: truncateUtf8(communitySlug),
    w: workgroups.values,
    b: periods.values,
    k: assets.values,
    p: [...byOutput.values()].sort((a, b) => a[0] - b[0]),
    ...(g.length > 0 ? { g } : {}),
  };
}

/** JSON byte size of a metadatum — an upper bound on its CBOR size. */
export function metadataJsonBytes(meta: object): number {
  return byteLength(JSON.stringify(meta));
}

export const payoutMetadataJsonBytes: (meta: PayoutMetadata) => number = metadataJsonBytes;

/** Throws `${what} (~N bytes of metadata)` when a record exceeds the JSON guard. */
export function assertMetadataFits(meta: object, what: string): void {
  const bytes = metadataJsonBytes(meta);
  if (bytes > MAX_METADATA_JSON_BYTES) {
    throw new Error(`${what} (~${bytes} bytes of metadata)`);
  }
}

/** Throws when a payout carries too many tasks to fit in one transaction. */
export function assertPayoutMetadataFits(meta: PayoutMetadata): void {
  const bytes = metadataJsonBytes(meta);
  if (bytes > MAX_METADATA_JSON_BYTES) {
    const tasks = meta.p.reduce((n, [, t]) => n + t.length, 0);
    throw new Error(
      `Payout too large for one transaction (${tasks} tasks, ~${bytes} bytes of metadata) — split it into smaller payouts`,
    );
  }
}

/** CIP-20 message object: { msg: [chunks ≤63 chars] }. */
export function buildMessageMetadata(message: string): { msg: string[] } {
  const chunks: string[] = [];
  let rest = message;
  while (rest.length > 0) {
    let chunk = rest.slice(0, MSG_CHUNK);
    // avoid splitting multi-byte chars over the 64-byte metadatum limit
    while (byteLength(chunk) > MAX_STR_BYTES) {
      chunk = chunk.slice(0, -1);
    }
    chunks.push(chunk);
    rest = rest.slice(chunk.length);
  }
  return { msg: chunks };
}
