// On-chain metadata for a manual payment (Payments page). It shares label
// 190001 with task payouts so every Guild Vault outflow is found under one
// label, and is told apart by `t: "payment"` and its `o` list: it has no `p`,
// so the payout readers (parsePayoutMeta, parsePayoutMetadata) never
// mistake it for a task payout. Strings obey the 64-byte metadatum cap.
//
// Shape — one entry per output of the tx body:
//   { v: 1, src: "guild-vault", t: "payment", c: <community slug>,
//     b: <budget period of the spend outputs: "YYYY-MM" | "YYYY-Qn" | "">,
//     k: [<asset ticker>, …], m?: <memo>,
//     o: [ [<output index>, [<amount>, …], <flag>], … ] }
// Amounts are aligned to `k` like a payout's: exact decimal strings in the
// asset's display units, "" where the output carries none of that asset,
// trailing "" trimmed. The flag is 0 for a payment charged to the treasury's
// budget and 1 for a transfer to another of the community's treasuries,
// which counts against no budget (hence `b` is "" when every output is a
// transfer). Min-UTxO lovelace forced onto token outputs stays in the body.
// Optional `g: [[<proposal number>, <content hash>], …]` names the decisions
// behind the whole payment (the budget proposal that set the period's
// budget, or the one a transfer funds); omitted when nothing is cited.

import { MAX_PAYMENT_MEMO_BYTES } from "@/lib/constants";
import { isRecord, isStringArray } from "@/lib/guards";
import {
  alignedAmounts, dedupeCitations, internList, isPaymentCitation, MAX_METADATA_JSON_BYTES, METADATA_SRC,
  metadataJsonBytes, truncateUtf8, type Citation,
} from "./metadata";

export const PAYMENT_METADATA_VERSION = 1;
export const PAYMENT_METADATA_TYPE = "payment";
/** JSON size guard (an upper bound on the CBOR size), as for payouts. */
export const MAX_PAYMENT_METADATA_JSON_BYTES = MAX_METADATA_JSON_BYTES;

/** 0 = spend charged to the treasury budget, 1 = transfer to a sibling treasury. */
export type PaymentOutputFlag = 0 | 1;
export type PaymentMetadataOutput = [o: number, x: string[], f: PaymentOutputFlag];

export interface PaymentMetadata {
  v: typeof PAYMENT_METADATA_VERSION;
  src: typeof METADATA_SRC;
  t: typeof PAYMENT_METADATA_TYPE;
  c: string;
  b: string;
  k: string[];
  m?: string;
  o: PaymentMetadataOutput[];
  /** The decisions behind the payment; absent when none is cited. */
  g?: PaymentCitation[];
}

/** One cited proposal: its number and content hash (sha256 hex). */
export type PaymentCitation = [n: number, h: string];

export interface PaymentOutputForMetadata {
  /** Index of the output in the tx body. */
  outputIndex: number;
  transfer: boolean;
  amounts: { ticker: string; quantity: bigint; decimals: number }[];
}


/**
 * Build the label-190001 payment record: entries ordered by output index,
 * every string within the metadatum cap, amounts scaled once with
 * `formatQuantity` (exact, no float math); zero quantities are absent.
 */
export function buildPaymentMetadata(
  communitySlug: string,
  budgetPeriod: string,
  memo: string | null | undefined,
  outputs: PaymentOutputForMetadata[],
  citations: readonly Citation[] = [],
): PaymentMetadata {
  const assets = internList();
  const entries: PaymentMetadataOutput[] = [];
  let spends = 0;

  for (const output of [...outputs].sort((a, b) => a.outputIndex - b.outputIndex)) {
    if (!output.transfer) spends += 1;
    entries.push([output.outputIndex, alignedAmounts(output.amounts, assets), output.transfer ? 1 : 0]);
  }

  const trimmedMemo = memo?.trim();
  const g: PaymentCitation[] = dedupeCitations(citations).map((c) => [c.number, c.contentHash]);
  return {
    v: PAYMENT_METADATA_VERSION,
    src: METADATA_SRC,
    t: PAYMENT_METADATA_TYPE,
    c: truncateUtf8(communitySlug),
    b: spends > 0 ? truncateUtf8(budgetPeriod) : "",
    k: assets.values,
    ...(trimmedMemo ? { m: truncateUtf8(trimmedMemo, MAX_PAYMENT_MEMO_BYTES) } : {}),
    o: entries,
    ...(g.length > 0 ? { g } : {}),
  };
}

export const paymentMetadataJsonBytes: (meta: PaymentMetadata) => number = metadataJsonBytes;

/** Throws when a payment carries too many outputs to fit in one transaction. */
export function assertPaymentMetadataFits(meta: PaymentMetadata): void {
  const bytes = metadataJsonBytes(meta);
  if (bytes > MAX_METADATA_JSON_BYTES) {
    throw new Error(
      `Payment too large for one transaction (${meta.o.length} outputs, ~${bytes} bytes of metadata) — split it into smaller payments`,
    );
  }
}

/**
 * Narrow a decoded label-190001 datum to a complete payment record, for the
 * chain import: unlike `parsePaymentMeta` below, which shows whatever it can
 * read, one malformed entry makes the whole record null (rows are rebuilt
 * from it, so a partial read would lose money).
 */
export function parsePaymentMetadata(value: unknown): PaymentMetadata | null {
  if (!isRecord(value)) return null;
  const m = value;
  if (m.v !== PAYMENT_METADATA_VERSION || m.src !== METADATA_SRC || m.t !== PAYMENT_METADATA_TYPE) {
    return null;
  }
  if (typeof m.c !== "string" || typeof m.b !== "string") return null;
  if (!isStringArray(m.k)) return null;
  if (m.m !== undefined && typeof m.m !== "string") return null;
  if (!Array.isArray(m.o)) return null;
  const tickers = m.k;
  const isOutput = (e: unknown): e is PaymentMetadataOutput =>
    Array.isArray(e) &&
    e.length === 3 &&
    typeof e[0] === "number" &&
    Number.isInteger(e[0]) &&
    e[0] >= 0 &&
    Array.isArray(e[1]) &&
    e[1].length <= tickers.length &&
    isStringArray(e[1]) &&
    (e[2] === 0 || e[2] === 1);
  if (!m.o.every(isOutput)) return null;
  if (m.g !== undefined && !(Array.isArray(m.g) && m.g.every(isPaymentCitation))) return null;
  return {
    v: PAYMENT_METADATA_VERSION,
    src: METADATA_SRC,
    t: PAYMENT_METADATA_TYPE,
    c: m.c,
    b: m.b,
    k: tickers,
    ...(typeof m.m === "string" ? { m: m.m } : {}),
    o: m.o,
    ...(m.g !== undefined ? { g: m.g as PaymentCitation[] } : {}),
  };
}

/** What the transaction page and the treasury activity list show of a payment record. */
export interface PaymentMetaView {
  /** "" when every output is a transfer. */
  period: string;
  memo: string | null;
  tickers: string[];
  outputs: { outputIndex: number; transfer: boolean; amounts: { ticker: string; amount: string }[] }[];
  /** The proposals cited (`g`), by number; [] when none. */
  citations: Citation[];
}

/**
 * Read a label-190001 datum defensively (it comes from the chain, so any
 * shape is possible). Returns null unless it is a Guild Vault payment record.
 */
export function parsePaymentMeta(meta: unknown): PaymentMetaView | null {
  if (!isRecord(meta)) return null;
  const m = meta;
  if (m.src !== METADATA_SRC || m.t !== PAYMENT_METADATA_TYPE || !Array.isArray(m.o)) return null;
  const tickers = Array.isArray(m.k) ? m.k.filter((k): k is string => typeof k === "string") : [];
  const outputs: PaymentMetaView["outputs"] = [];
  for (const entry of m.o) {
    if (!Array.isArray(entry) || typeof entry[0] !== "number" || !Array.isArray(entry[1])) continue;
    const amounts: { ticker: string; amount: string }[] = [];
    entry[1].forEach((amount, k) => {
      if (typeof amount === "string" && amount !== "") amounts.push({ ticker: tickers[k] ?? `#${k}`, amount });
    });
    outputs.push({ outputIndex: entry[0], transfer: entry[2] === 1, amounts });
  }
  const citations: Citation[] = Array.isArray(m.g)
    ? m.g.filter(isPaymentCitation).map(([number, contentHash]) => ({ number, contentHash }))
    : [];
  return {
    period: typeof m.b === "string" ? m.b : "",
    memo: typeof m.m === "string" && m.m !== "" ? m.m : null,
    tickers,
    outputs: outputs.sort((a, b) => a.outputIndex - b.outputIndex),
    citations,
  };
}
