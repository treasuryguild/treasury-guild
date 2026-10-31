// Pure DRep search helpers (client-safe). The Koios fetch lives in koios.ts.
// Names come from CIP-119 givenName via /drep_metadata (not a column on /drep_list).

export const DREP_DEFAULT_LIMIT = 40;
export const DREP_MAX_LIMIT = 50;
/** Extra registered rows fetched when filtering by givenName (no PostgREST name column). */
export const DREP_NAME_SEARCH_FETCH = 100;
/** Koios bulk `_drep_ids` chunk size — larger posts get HTTP 413. */
export const DREP_KOIOS_ID_BATCH = 20;

export const DREP_ALWAYS_ABSTAIN = "always_abstain";
export const DREP_ALWAYS_NO_CONFIDENCE = "always_no_confidence";

const DREP_LIST_SELECT = "drep_id,hex,has_script,registered";

/** Characters that break or widen PostgREST `or=(…)` / `ilike` filters. */
const POSTGREST_FILTER_UNSAFE = /[*(),]/g;

export interface DrepSummary {
  dRepId: string;
  givenName: string | null;
  votingPower: string | null;
  registered: boolean;
  hasScript: boolean;
}

export interface KoiosDrepListRow {
  drep_id?: string | null;
  hex?: string | null;
  has_script?: boolean | null;
  registered?: boolean | null;
}

export interface KoiosDrepInfoRow {
  drep_id?: string | null;
  amount?: string | null;
  active?: boolean | null;
  drep_status?: string | null;
}

export interface KoiosDrepMetadataRow {
  drep_id?: string | null;
  meta_json?: unknown;
}

/**
 * Trim and strip PostgREST filter metacharacters so a user query cannot inject
 * `or=(…)` clauses or ilike wildcards.
 */
export function sanitizeDrepSearchQuery(q: string): string {
  return q.trim().replace(POSTGREST_FILTER_UNSAFE, "");
}

export function clampDrepSearchLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DREP_DEFAULT_LIMIT;
  const n = Math.trunc(limit);
  if (n < 1) return 1;
  if (n > DREP_MAX_LIMIT) return DREP_MAX_LIMIT;
  return n;
}

/** Built-in vote-delegation targets that never hit Koios. */
export function isSpecialDrepId(dRepId: string): boolean {
  const id = dRepId.trim();
  return id === DREP_ALWAYS_ABSTAIN || id === DREP_ALWAYS_NO_CONFIDENCE;
}

/**
 * Id-shaped queries can use PostgREST on /drep_list; free text is filtered
 * client-side against givenName after a larger registered fetch.
 */
export function isDrepIdShapedQuery(q: string): boolean {
  const s = sanitizeDrepSearchQuery(q).toLowerCase();
  if (!s) return false;
  if (s.startsWith("drep")) return true;
  // Hex fragment (script/key hash); require enough chars to be useful.
  return /^[0-9a-f]{6,}$/i.test(s);
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

/**
 * Build the Koios `GET /drep_list` path. Empty sanitized `q` → registered browse.
 * Id-shaped `q` → ilike on bech32 / hex. Callers that pass free-text names should
 * request a larger limit via `listLimit` and filter after metadata enrichment.
 */
export function buildDrepListPath(opts: {
  q?: string;
  limit?: number;
  /** Override fetch size (name search over-fetch). */
  listLimit?: number;
}): string {
  const limit = opts.listLimit ?? clampDrepSearchLimit(opts.limit);
  const q = sanitizeDrepSearchQuery(opts.q ?? "");
  const params = new URLSearchParams();
  params.set("registered", "eq.true");
  params.set("select", DREP_LIST_SELECT);
  params.set("limit", String(limit));
  if (q && isDrepIdShapedQuery(q)) {
    params.set("or", `(drep_id.ilike.*${q}*,hex.ilike.*${q}*)`);
  } else {
    params.set("order", "drep_id.asc");
  }
  return `/drep_list?${postgrestQuery(params)}`;
}

/**
 * Exact lookup by bech32 (`drep1…`) or hex id (includes unregistered rows —
 * titles still want the givenName when known).
 */
export function buildDrepLookupPath(dRepId: string): string {
  const id = sanitizeDrepSearchQuery(dRepId);
  const params = new URLSearchParams();
  params.set("select", DREP_LIST_SELECT);
  params.set("limit", "1");
  if (/^[0-9a-fA-F]{56}$/.test(id)) {
    params.set("hex", `eq.${id}`);
  } else {
    params.set("drep_id", `eq.${id}`);
  }
  return `/drep_list?${postgrestQuery(params)}`;
}

/** CIP-119 givenName from Koios `meta_json` (object or JSON string). */
export function extractDrepGivenName(metaJson: unknown): string | null {
  let doc: unknown = metaJson;
  if (typeof doc === "string") {
    try {
      doc = JSON.parse(doc) as unknown;
    } catch {
      return null;
    }
  }
  if (!doc || typeof doc !== "object") return null;
  const body = (doc as { body?: unknown }).body;
  if (!body || typeof body !== "object") return null;
  const name = (body as { givenName?: unknown }).givenName;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mapKoiosDrepListRow(row: KoiosDrepListRow): DrepSummary | null {
  const dRepId = typeof row.drep_id === "string" ? row.drep_id.trim() : "";
  if (!dRepId) return null;
  return {
    dRepId,
    givenName: null,
    votingPower: null,
    registered: row.registered === true,
    hasScript: row.has_script === true,
  };
}

export function mapKoiosDrepListRows(rows: unknown): DrepSummary[] {
  if (!Array.isArray(rows)) return [];
  const out: DrepSummary[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const mapped = mapKoiosDrepListRow(row as KoiosDrepListRow);
    if (mapped) out.push(mapped);
  }
  return out;
}

/** Merge voting power and givenName onto list rows (mutates copies). */
export function enrichDrepSummaries(
  list: readonly DrepSummary[],
  infoById: ReadonlyMap<string, string | null>,
  nameById: ReadonlyMap<string, string | null>,
): DrepSummary[] {
  return list.map((d) => ({
    ...d,
    votingPower: infoById.has(d.dRepId) ? (infoById.get(d.dRepId) ?? null) : d.votingPower,
    givenName: nameById.has(d.dRepId) ? (nameById.get(d.dRepId) ?? null) : d.givenName,
  }));
}

export function filterDrepsByGivenName(
  dreps: readonly DrepSummary[],
  q: string,
  limit: number,
): DrepSummary[] {
  const needle = sanitizeDrepSearchQuery(q).toLowerCase();
  if (!needle) return dreps.slice(0, limit);
  const matched = dreps.filter((d) => d.givenName?.toLowerCase().includes(needle));
  return matched.slice(0, limit);
}

/** Sort by voting power (lovelace string) descending; missing power last. */
export function sortDrepsByVotingPower(dreps: readonly DrepSummary[]): DrepSummary[] {
  return [...dreps].sort((a, b) => {
    const av = a.votingPower != null && a.votingPower !== "" ? BigInt(a.votingPower) : null;
    const bv = b.votingPower != null && b.votingPower !== "" ? BigInt(b.votingPower) : null;
    if (av == null && bv == null) return a.dRepId.localeCompare(b.dRepId);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av === bv) return a.dRepId.localeCompare(b.dRepId);
    return av > bv ? -1 : 1;
  });
}
