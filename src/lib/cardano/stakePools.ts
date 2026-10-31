// Pure stake-pool search helpers (client-safe). The Koios fetch lives in koios.ts.

export const STAKE_POOL_DEFAULT_LIMIT = 40;
export const STAKE_POOL_MAX_LIMIT = 50;

const POOL_LIST_SELECT =
  "pool_id_bech32,ticker,margin,fixed_cost,active_stake,pool_status";

/** Characters that break or widen PostgREST `or=(…)` / `ilike` filters. */
const POSTGREST_FILTER_UNSAFE = /[*(),]/g;

export interface StakePoolSummary {
  poolId: string;
  ticker: string | null;
  margin: number | null;
  fixedCost: string | null;
  activeStake: string | null;
  status: string;
}

export interface KoiosPoolListRow {
  pool_id_bech32?: string | null;
  ticker?: string | null;
  margin?: number | null;
  fixed_cost?: string | null;
  active_stake?: string | null;
  pool_status?: string | null;
}

/**
 * Trim and strip PostgREST filter metacharacters so a user query cannot inject
 * `or=(…)` clauses or ilike wildcards.
 */
export function sanitizePoolSearchQuery(q: string): string {
  return q.trim().replace(POSTGREST_FILTER_UNSAFE, "");
}

export function clampPoolSearchLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return STAKE_POOL_DEFAULT_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  if (n > STAKE_POOL_MAX_LIMIT) return STAKE_POOL_MAX_LIMIT;
  return n;
}

/**
 * Build the Koios `GET /pool_list` path (leading slash, query string included).
 * Empty sanitized `q` → registered pools that have a ticker, ordered by ticker.
 */
export function buildPoolListPath(opts: { q?: string; limit?: number }): string {
  const limit = clampPoolSearchLimit(opts.limit);
  const q = sanitizePoolSearchQuery(opts.q ?? "");
  const params = new URLSearchParams();
  params.set("pool_status", "eq.registered");
  params.set("select", POOL_LIST_SELECT);
  params.set("limit", String(limit));
  if (q) {
    // Literal `*` wildcards stay unencoded; encodeURIComponent would turn them into %2A.
    params.set(
      "or",
      `(ticker.ilike.*${q}*,pool_id_bech32.ilike.*${q}*,pool_id_hex.ilike.*${q}*)`,
    );
  } else {
    params.set("ticker", "not.is.null");
    params.set("order", "ticker.asc");
  }
  // URLSearchParams encodes `*` as %2A and parentheses; Koios/PostgREST expect
  // the wildcard form. Rebuild with selective encoding.
  return `/pool_list?${postgrestQuery(params)}`;
}

/**
 * Exact lookup by bech32 (`pool1…`) or 56-char hex id (retired pools included —
 * titles still want the ticker when known).
 */
export function buildPoolLookupPath(poolId: string): string {
  const id = sanitizePoolSearchQuery(poolId);
  const params = new URLSearchParams();
  params.set("select", POOL_LIST_SELECT);
  params.set("limit", "1");
  if (/^[0-9a-fA-F]{56}$/.test(id)) {
    params.set("pool_id_hex", `eq.${id}`);
  } else {
    params.set("pool_id_bech32", `eq.${id}`);
  }
  return `/pool_list?${postgrestQuery(params)}`;
}

/** Encode values but keep PostgREST wildcards and `or=(…)` punctuation intact. */
function postgrestQuery(params: URLSearchParams): string {
  const parts: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "or" || (key !== "select" && value.includes("*"))) {
      parts.push(`${encodeURIComponent(key)}=${value}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join("&");
}

export function mapKoiosPoolRow(row: KoiosPoolListRow): StakePoolSummary | null {
  const poolId = typeof row.pool_id_bech32 === "string" ? row.pool_id_bech32.trim() : "";
  if (!poolId) return null;
  return {
    poolId,
    ticker: typeof row.ticker === "string" && row.ticker.length > 0 ? row.ticker : null,
    margin: typeof row.margin === "number" && Number.isFinite(row.margin) ? row.margin : null,
    fixedCost: typeof row.fixed_cost === "string" ? row.fixed_cost : null,
    activeStake: typeof row.active_stake === "string" ? row.active_stake : null,
    status: typeof row.pool_status === "string" ? row.pool_status : "registered",
  };
}

export function mapKoiosPoolRows(rows: unknown): StakePoolSummary[] {
  if (!Array.isArray(rows)) return [];
  const out: StakePoolSummary[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const mapped = mapKoiosPoolRow(row as KoiosPoolListRow);
    if (mapped) out.push(mapped);
  }
  return out;
}
