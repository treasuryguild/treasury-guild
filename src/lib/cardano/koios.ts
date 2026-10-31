// Server-side Koios REST helpers for endpoints the Mesh KoiosProvider doesn't
// expose. Koios sends no CORS headers, so these must never run in the browser.
import "server-only";

import type { Network } from "@/lib/config";
import { koiosApiKey, koiosBaseUrl } from "@/lib/env.server";
import { UpstreamError } from "@/lib/errors";
import {
  DREP_KOIOS_ID_BATCH,
  DREP_NAME_SEARCH_FETCH,
  buildDrepListPath,
  buildDrepLookupPath,
  clampDrepSearchLimit,
  enrichDrepSummaries,
  extractDrepGivenName,
  filterDrepsByGivenName,
  isDrepIdShapedQuery,
  isSpecialDrepId,
  mapKoiosDrepListRows,
  sanitizeDrepSearchQuery,
  sortDrepsByVotingPower,
  type DrepSummary,
  type KoiosDrepInfoRow,
  type KoiosDrepMetadataRow,
} from "./dreps";
import {
  buildPoolListPath,
  buildPoolLookupPath,
  mapKoiosPoolRow,
  mapKoiosPoolRows,
  type StakePoolSummary,
} from "./stakePools";
import { joinUnit, splitUnit } from "./units";

export type { StakePoolSummary } from "./stakePools";
export type { DrepSummary } from "./dreps";

const PAGE_SIZE = 500;
const MAX_PAGES = 8;
const TIMEOUT_MS = 15_000;

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  const apiKey = koiosApiKey();
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

async function koiosFetch(
  network: Network,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const res = await fetch(`${koiosBaseUrl(network)}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Log the upstream body server-side; never echo it to clients.
    const body = await res.text().catch(() => "");
    console.error(`Koios ${path} failed: ${res.status} ${body.slice(0, 300)}`);
    throw new UpstreamError(`Koios ${path} failed: ${res.status}`);
  }
  return res.json();
}

export async function koiosPost(
  network: Network,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return koiosFetch(network, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function koiosGet(network: Network, path: string): Promise<unknown> {
  return koiosFetch(network, path, { method: "GET" });
}

/** POST with offset pagination until a short page arrives (8-page cap). */
async function koiosPostAllPages<T>(
  network: Network,
  path: string,
  body: Record<string, unknown>,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const rows = (await koiosFetch(
      network,
      `${path}${sep}offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`,
      { method: "POST", body: JSON.stringify(body) },
    )) as T[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return all;
}

// --- Typed helpers for the endpoints reconciliation needs ---

export interface KoiosAddressTx {
  tx_hash: string;
  epoch_no: number;
  block_height: number;
  block_time: number;
}

export async function addressTxs(
  network: Network,
  address: string,
  afterBlockHeight?: number,
): Promise<KoiosAddressTx[]> {
  const body: Record<string, unknown> = { _addresses: [address] };
  if (afterBlockHeight && afterBlockHeight > 0) {
    body._after_block_height = afterBlockHeight;
  }
  return koiosPostAllPages<KoiosAddressTx>(network, "/address_txs", body);
}

export interface KoiosAssetEntry {
  policy_id: string;
  asset_name: string | null;
  quantity: string;
}

export interface KoiosTxInfo {
  tx_hash: string;
  block_height: number;
  tx_timestamp: number;
  /** Lovelace, as a decimal string. */
  fee?: string;
  inputs: {
    payment_addr: { bech32: string };
    value: string;
    asset_list?: KoiosAssetEntry[] | null;
  }[];
  /**
   * Koios returns outputs in no particular order: the body position is
   * `tx_index`, never the array position.
   */
  outputs: {
    payment_addr: { bech32: string };
    value: string;
    tx_index?: number;
    asset_list?: KoiosAssetEntry[] | null;
  }[];
  /** Transaction metadata keyed by label (e.g. "190001"), when requested. */
  metadata?: Record<string, unknown> | null;
  /** Certificates (`_certs: true`): stake / DRep / MIR / pool. */
  certificates?: {
    index?: number | null;
    type?: string | null;
    info?: Record<string, unknown> | null;
  }[] | null;
  /** Reward withdrawals (`_withdrawals: true`). */
  withdrawals?: { amount?: string | null; stake_addr?: string | null }[] | null;
  /** On-chain governance votes (`_governance: true`). */
  voting_procedures?: {
    voter?: string | null;
    vote?: string | null;
    proposal_tx_hash?: string | null;
  }[] | null;
}

export async function txInfoBulk(
  network: Network,
  txHashes: string[],
): Promise<KoiosTxInfo[]> {
  if (txHashes.length === 0) return [];
  const out: KoiosTxInfo[] = [];
  // tx_info accepts arrays; chunk to keep request bodies reasonable
  for (let i = 0; i < txHashes.length; i += 50) {
    const rows = (await koiosPost(network, "/tx_info", {
      _tx_hashes: txHashes.slice(i, i + 50),
      _inputs: true,
      _assets: true,
      _metadata: true,
      _certs: true,
      _withdrawals: true,
      _governance: true,
    })) as KoiosTxInfo[];
    out.push(...rows);
  }
  return out;
}

/**
 * The submitted bytes of confirmed transactions (body and witnesses) via
 * POST /tx_cbor, keyed by hash. A hash Koios has no bytes for is absent.
 */
export async function txCborBulk(
  network: Network,
  txHashes: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < txHashes.length; i += 50) {
    const rows = (await koiosPost(network, "/tx_cbor", {
      _tx_hashes: txHashes.slice(i, i + 50),
    })) as { tx_hash: string; cbor: string | null }[];
    for (const row of rows) {
      if (row.cbor) out.set(row.tx_hash, row.cbor);
    }
  }
  return out;
}

export interface KoiosAssetInfo {
  policy_id: string;
  asset_name: string | null; // hex
  asset_name_ascii: string | null;
  token_registry_metadata: {
    ticker?: string;
    name?: string;
    decimals?: number;
  } | null;
  cip68_metadata: unknown | null;
  /** Metadata of the minting tx keyed by label, e.g. {"721": {...}}. */
  minting_tx_metadata?: unknown | null;
}

/**
 * Bulk token metadata via POST /asset_info. Units are policyId(56)+nameHex;
 * the result map is keyed the same way. Do NOT use Mesh's
 * KoiosProvider.fetchAssetMetadata for this — it only understands CIP-25
 * minting metadata and throws on fungible tokens.
 */
export async function assetInfoBulk(
  network: Network,
  units: string[],
): Promise<Map<string, KoiosAssetInfo>> {
  const out = new Map<string, KoiosAssetInfo>();
  if (units.length === 0) return out;
  const list = units.map((u) => {
    const { policyId, assetNameHex } = splitUnit(u);
    return [policyId, assetNameHex];
  });
  for (let i = 0; i < list.length; i += 50) {
    const rows = (await koiosPost(network, "/asset_info", {
      _asset_list: list.slice(i, i + 50),
    })) as KoiosAssetInfo[];
    for (const row of rows) {
      out.set(joinUnit(row.policy_id, row.asset_name), row);
    }
  }
  return out;
}

// --- Stake account / DRep / governance proposals (SDK staking) ---------------

export interface KoiosAccountInfo {
  stake_address: string;
  status: "registered" | "not registered" | string;
  delegated_pool: string | null;
  delegated_drep: string | null;
  rewards_available: string;
  total_balance?: string;
}

export interface StakeAccountStatus {
  active: boolean;
  poolId: string | null;
  dRepId: string | null;
  rewardsAvailable: string;
}

/** POST /account_info — empty / missing row means never registered. */
export async function fetchStakeAccountStatus(
  network: Network,
  rewardAddress: string,
): Promise<StakeAccountStatus> {
  const rows = (await koiosPost(network, "/account_info", {
    _stake_addresses: [rewardAddress],
  })) as KoiosAccountInfo[];
  const row = rows[0];
  if (!row) return { active: false, poolId: null, dRepId: null, rewardsAvailable: "0" };
  return {
    active: row.status === "registered",
    poolId: row.delegated_pool ?? null,
    dRepId: row.delegated_drep ?? null,
    rewardsAvailable: row.rewards_available ?? "0",
  };
}

export interface KoiosDrepInfo {
  drep_id: string;
  drep_status: "registered" | "deregistered" | "not_registered" | string;
  active: boolean;
  amount?: string;
  meta_url?: string | null;
}

export interface DrepOnChainStatus {
  active: boolean;
  votingPower: string | null;
  metaUrl: string | null;
}

/** POST /drep_info — missing row means never registered. */
export async function fetchDrepStatus(
  network: Network,
  dRepId: string,
): Promise<DrepOnChainStatus> {
  const rows = (await koiosPost(network, "/drep_info", {
    _drep_ids: [dRepId],
  })) as KoiosDrepInfo[];
  const row = rows[0];
  if (!row) return { active: false, votingPower: null, metaUrl: null };
  return {
    active: row.drep_status === "registered" && row.active === true,
    votingPower: row.amount ?? null,
    metaUrl: row.meta_url ?? null,
  };
}

export interface KoiosProposal {
  proposal_id?: string;
  tx_hash: string;
  cert_index: number;
  governance_type?: string;
  expiration?: number | null;
  ratified_epoch?: number | null;
  enacted_epoch?: number | null;
  dropped_epoch?: number | null;
  meta_url?: string | null;
  meta_title?: string | null;
  meta_abstract?: string | null;
}

/** Active governance proposals (not ratified/enacted/dropped). */
export async function fetchActiveProposals(network: Network): Promise<KoiosProposal[]> {
  const rows = (await koiosGet(network, "/proposal_list")) as KoiosProposal[];
  return (rows ?? []).filter(
    (p) => p.ratified_epoch == null && p.enacted_epoch == null && p.dropped_epoch == null,
  );
}

/**
 * Search registered stake pools (Koios `GET /pool_list` + PostgREST filters).
 * Empty `q` returns a ticker-sorted browse page; see `buildPoolListPath`.
 */
export async function searchStakePools(
  network: Network,
  opts: { q?: string; limit?: number } = {},
): Promise<StakePoolSummary[]> {
  const rows = await koiosGet(network, buildPoolListPath(opts));
  return mapKoiosPoolRows(rows);
}

/** One pool by bech32 or hex id, or null when Koios has no row. */
export async function lookupStakePool(
  network: Network,
  poolId: string,
): Promise<StakePoolSummary | null> {
  const trimmed = poolId.trim();
  if (!trimmed) return null;
  const rows = await koiosGet(network, buildPoolLookupPath(trimmed));
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (!row || typeof row !== "object") return null;
  return mapKoiosPoolRow(row);
}

function chunkIds(ids: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push([...ids.slice(i, i + size)]);
  }
  return out;
}

async function fetchDrepInfoByIds(
  network: Network,
  dRepIds: readonly string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (dRepIds.length === 0) return map;
  for (const batch of chunkIds(dRepIds, DREP_KOIOS_ID_BATCH)) {
    const rows = (await koiosPost(network, "/drep_info", {
      _drep_ids: batch,
    })) as KoiosDrepInfoRow[];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const id = typeof row.drep_id === "string" ? row.drep_id.trim() : "";
      if (!id) continue;
      map.set(id, typeof row.amount === "string" ? row.amount : null);
    }
  }
  return map;
}

async function fetchDrepNamesByIds(
  network: Network,
  dRepIds: readonly string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (dRepIds.length === 0) return map;
  for (const batch of chunkIds(dRepIds, DREP_KOIOS_ID_BATCH)) {
    const rows = (await koiosPost(network, "/drep_metadata", {
      _drep_ids: batch,
    })) as KoiosDrepMetadataRow[];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const id = typeof row.drep_id === "string" ? row.drep_id.trim() : "";
      if (!id) continue;
      map.set(id, extractDrepGivenName(row.meta_json));
    }
  }
  return map;
}

async function enrichDrepList(
  network: Network,
  list: DrepSummary[],
  opts: { names?: boolean; votingPower?: boolean } = { names: true, votingPower: true },
): Promise<DrepSummary[]> {
  const ids = list.map((d) => d.dRepId);
  const [infoById, nameById] = await Promise.all([
    opts.votingPower !== false
      ? fetchDrepInfoByIds(network, ids)
      : Promise.resolve(new Map<string, string | null>()),
    opts.names !== false
      ? fetchDrepNamesByIds(network, ids)
      : Promise.resolve(new Map<string, string | null>()),
  ]);
  return enrichDrepSummaries(list, infoById, nameById);
}

/**
 * Search registered DReps (Koios `/drep_list` + `/drep_info` + `/drep_metadata`).
 * Empty `q` browses by voting power; id-shaped `q` filters on-chain; free-text
 * filters givenName over a larger registered window (see `DREP_NAME_SEARCH_FETCH`).
 * Bulk Koios posts are chunked (`DREP_KOIOS_ID_BATCH`) to avoid HTTP 413.
 */
export async function searchDreps(
  network: Network,
  opts: { q?: string; limit?: number } = {},
): Promise<DrepSummary[]> {
  const limit = clampDrepSearchLimit(opts.limit);
  const q = sanitizeDrepSearchQuery(opts.q ?? "");
  const nameSearch = Boolean(q) && !isDrepIdShapedQuery(q);
  const listLimit = nameSearch ? DREP_NAME_SEARCH_FETCH : limit;
  const rows = await koiosGet(
    network,
    buildDrepListPath({
      q: nameSearch ? undefined : q || undefined,
      limit,
      listLimit,
    }),
  );
  const listed = mapKoiosDrepListRows(rows);
  if (nameSearch) {
    // Names first (needed to filter); voting power only for matches — keeps
    // bulk bodies small and avoids enriching 100 rows that will be dropped.
    const withNames = await enrichDrepList(network, listed, {
      names: true,
      votingPower: false,
    });
    const matched = filterDrepsByGivenName(withNames, q, limit);
    return enrichDrepList(network, matched, { names: false, votingPower: true });
  }
  let list = await enrichDrepList(network, listed);
  if (!q) {
    list = sortDrepsByVotingPower(list).slice(0, limit);
  } else {
    list = list.slice(0, limit);
  }
  return list;
}

/**
 * One DRep by bech32 or hex id, or null when Koios has no row.
 * Special vote-delegation targets (`always_abstain` / `always_no_confidence`)
 * never hit Koios.
 */
export async function lookupDrep(
  network: Network,
  dRepId: string,
): Promise<DrepSummary | null> {
  const trimmed = dRepId.trim();
  if (!trimmed || isSpecialDrepId(trimmed)) return null;
  const rows = await koiosGet(network, buildDrepLookupPath(trimmed));
  const list = mapKoiosDrepListRows(rows);
  if (list.length === 0) {
    // Metadata may still resolve a name when the list row is missing.
    const nameById = await fetchDrepNamesByIds(network, [trimmed]);
    const givenName = nameById.get(trimmed) ?? null;
    if (!givenName) return null;
    return {
      dRepId: trimmed,
      givenName,
      votingPower: null,
      registered: false,
      hasScript: false,
    };
  }
  const [enriched] = await enrichDrepList(network, list.slice(0, 1));
  return enriched ?? null;
}

// --- CIP-0146 label-1854 registration discovery ------------------------------

const METALABEL_PAGE_SIZE = 100;
/** Bound fan-out like multisig's Blockfrost 10×100 ceiling. */
const METALABEL_MAX_PAGES = 10;

export interface KoiosMetalabelTx {
  tx_hash: string;
  block_height?: number;
  epoch_no?: number;
  absolute_slot?: number;
}

/**
 * Transactions that carry a given metadata label, oldest first.
 * Koios `GET /tx_by_metalabel?_label=…` with offset pagination.
 */
export async function txsByMetalabel(
  network: Network,
  label: number | string,
): Promise<string[]> {
  const hashes: string[] = [];
  for (let page = 0; page < METALABEL_MAX_PAGES; page++) {
    const rows = (await koiosGet(
      network,
      `/tx_by_metalabel?_label=${encodeURIComponent(String(label))}&offset=${page * METALABEL_PAGE_SIZE}&limit=${METALABEL_PAGE_SIZE}`,
    )) as KoiosMetalabelTx[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      if (typeof row.tx_hash === "string") hashes.push(row.tx_hash.toLowerCase());
    }
    if (rows.length < METALABEL_PAGE_SIZE) break;
  }
  return hashes;
}

export interface KoiosTxMetadataRow {
  tx_hash: string;
  metadata: Record<string, unknown> | null;
}

/** POST /tx_metadata — metadata keyed by label for each hash. */
export async function txMetadataBulk(
  network: Network,
  txHashes: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (txHashes.length === 0) return out;
  for (let i = 0; i < txHashes.length; i += 50) {
    const rows = (await koiosPost(network, "/tx_metadata", {
      _tx_hashes: txHashes.slice(i, i + 50),
    })) as KoiosTxMetadataRow[];
    for (const row of rows) {
      if (row.metadata && typeof row.metadata === "object") {
        out.set(row.tx_hash.toLowerCase(), row.metadata as Record<string, unknown>);
      }
    }
  }
  return out;
}
