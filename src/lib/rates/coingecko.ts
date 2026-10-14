// Fiat exchange rates for the Discord footer, from CoinGecko's public API
// (no key). Best-effort: any failure yields null and the footer shows the
// date alone. Rates are cached in-process for a few minutes so a cron sweep
// announcing several payouts makes one request per coin.
import "server-only";

import type { ExchangeRate } from "@/lib/discord/payoutMessage";
import type { FetchLike } from "@/lib/discord/webhook";

const BASE = "https://api.coingecko.com/api/v3";
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; rate: ExchangeRate | null }>();

interface MarketRow {
  symbol?: unknown;
  current_price?: unknown;
}

/**
 * Current price of `coinId` (a CoinGecko id such as "cardano" or
 * "singularitynet") in `currency` ("usd", "eur", …), or null when unknown.
 */
export async function fetchExchangeRate(
  coinId: string,
  currency: string,
  fetchImpl: FetchLike = (u, init) => fetch(u, init),
  now = Date.now(),
): Promise<ExchangeRate | null> {
  const key = `${coinId}:${currency}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.rate;

  const rate = await lookup(coinId, currency, fetchImpl);
  cache.set(key, { at: now, rate });
  return rate;
}

async function lookup(coinId: string, currency: string, fetchImpl: FetchLike): Promise<ExchangeRate | null> {
  const url = `${BASE}/coins/markets?vs_currency=${encodeURIComponent(currency)}&ids=${encodeURIComponent(coinId)}&precision=full`;
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      console.warn(`coingecko ${coinId}/${currency}: ${res.status}`);
      return null;
    }
    const body = (await res.json()) as unknown;
    const row = Array.isArray(body) ? (body[0] as MarketRow | undefined) : undefined;
    if (!row || typeof row.current_price !== "number" || !Number.isFinite(row.current_price)) return null;
    return {
      price: row.current_price,
      currency: currency.toLowerCase(),
      symbol: typeof row.symbol === "string" && row.symbol ? row.symbol.toUpperCase() : coinId.toUpperCase(),
    };
  } catch (err) {
    console.warn(`coingecko ${coinId}/${currency} failed`, err);
    return null;
  }
}

/** Tests only. */
export function clearRateCache(): void {
  cache.clear();
}
