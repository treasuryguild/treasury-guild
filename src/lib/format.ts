// Display formatters. All quantity formatting is exact (string/bigint based —
// never Number() on on-chain integers). Client-safe.

import { ADA_ASSET, formatQuantity } from "@/lib/assets";

const LOVELACE_DECIMALS = ADA_ASSET.decimals;
const ADA_SYMBOL = "₳";

/** Insert thousands separators into a plain integer string. */
function groupInteger(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Exact human-unit rendering of an on-chain integer quantity:
 * 1050000000n @ 8 -> "10.5"; 123456789n @ 6 -> "123.456789";
 * with a ticker: "10.5 HOSKY". Handles negatives (burns).
 */
export function formatUnits(
  qty: bigint | string | number,
  decimals: number,
  ticker?: string,
): string {
  let value = typeof qty === "bigint" ? qty : BigInt(qty);
  const negative = value < 0n;
  if (negative) value = -value;
  const raw = formatQuantity(value, decimals);
  const [whole, frac] = raw.split(".");
  const grouped = groupInteger(whole ?? "0");
  const body = frac ? `${grouped}.${frac}` : grouped;
  const signed = negative ? `-${body}` : body;
  return ticker ? `${signed} ${ticker}` : signed;
}

/** Lovelace -> "12.5 ₳" (exact). */
export function formatLovelace(lovelace: bigint | string | number): string {
  return formatUnits(lovelace, LOVELACE_DECIMALS, ADA_SYMBOL);
}

/** "1 output", "3 outputs" (`words` for an irregular plural). */
export function plural(n: number, word: string, words = `${word}s`): string {
  return `${n} ${n === 1 ? word : words}`;
}

export function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-6)}`;
}

/**
 * Compact label for an unknown unit (policyId + assetName hex). The
 * ellipsis-free variant is used where the string lands in on-chain metadata.
 */
export function shortUnit(unit: string, ellipsis = true): string {
  const head = unit.slice(0, 12);
  return ellipsis ? `${head}…` : head;
}

/** `text` cut to at most `max` characters, "…" marking the cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function shortHash(hash: string, chars = 20): string {
  return hash.length <= chars ? hash : `${hash.slice(0, chars)}…`;
}

export function formatDate(
  iso: string | Date,
  style: "date" | "datetime" = "date",
): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return style === "datetime" ? d.toLocaleString() : d.toLocaleDateString();
}
