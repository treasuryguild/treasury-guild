// The chain import: turn the external rows of a treasury that carry a Guild
// Vault label-190001 record into the rows the app would have written itself.
// Runs after every treasury poll (the sweep and the on-visit sync) and from
// the admin routes. pollTreasury stays discovery-only; concurrent runs are
// safe because import_chain_tx locks the external row and is idempotent.
//
// The record and the outputs are read from the transaction's own bytes
// (fetched from Koios and verified against the hash), never from
// external_txs.payout_meta, which only selects the candidates.
import "server-only";

import { resolveTxHash } from "@meshsdk/core-cst";

import type { AssetDef } from "@/lib/assets";
import { budgetTokenLabel } from "@/lib/budgets";
import { decodeTxOutputs, extractPayoutMetadata } from "@/lib/cardano/cborMetadata";
import { txCborBulk } from "@/lib/cardano/koios";
import { METADATA_SRC, parsePayoutMetadata, PAYOUT_METADATA_VERSION } from "@/lib/cardano/metadata";
import {
  parsePaymentMetadata,
  PAYMENT_METADATA_TYPE,
  PAYMENT_METADATA_VERSION,
} from "@/lib/cardano/paymentMetadata";
import { witnessKeyHashes } from "@/lib/cardano/txSignUtils";
import { describeTokens } from "@/lib/cardano/walletAssets";
import { asNetwork } from "@/lib/config";
import { ChainImportIssueCode as Code, ChainImportStatus, PgCode } from "@/lib/constants";
import { isRecord } from "@/lib/guards";
import {
  importChainTx,
  loadImportCandidates,
  loadImportContext,
  loadTasksByNumber,
  markExternalTx,
  stampImportChecked,
  type ImportContext,
  type ImportTreasury,
} from "@/lib/db/chainImport";
import { loadMemberLabels } from "@/lib/db/payments";
import type { ExternalTxRow } from "@/lib/db/types";
import {
  planPaymentImport,
  planPayoutImport,
  resolveTickers,
  type ImportOutput,
} from "./plan";
import type { ChainImportIssue, ChainImportPlanResult } from "./types";

const DEFAULT_LIMIT = 10;
/** Koios serves a confirmed tx's bytes at once; after this, none are coming. */
const CBOR_GIVE_UP_MS = 24 * 60 * 60 * 1000;
// A type alias (not an interface) so the route wrapper's JSON type accepts it.
export type ChainImportRunResult = {
  /** Hashes now recorded as transactions. */
  imported: string[];
  /** Hashes held for an admin, with the reasons. */
  blocked: { txHash: string; issues: ChainImportIssue[] }[];
};

export interface ChainImportOptions {
  /** An admin's action: exactly these rows, whatever their import state. */
  hashes?: string[];
  /** Chain task numbers an admin chose to import under a new number. */
  asNewNumbers?: number[];
  limit?: number;
}


function outputsOf(txCbor: string): ImportOutput[] {
  return decodeTxOutputs(txCbor).map((o) => ({
    address: o.address,
    lovelace: BigInt(o.lovelace),
    assets: new Map(o.assets.map((a) => [a.unit, BigInt(a.quantity)])),
  }));
}

/** Labels of the tokens in the outputs, only when a ticker needs them. */
async function candidateTokens(
  treasury: ImportTreasury,
  context: ImportContext,
  tickers: readonly string[],
  outputs: readonly ImportOutput[],
): Promise<AssetDef[]> {
  const known = resolveTickers(tickers, { registry: context.registry, mints: context.mints, candidates: [] });
  if (known.issues.length === 0) return [];
  const units = [...new Set(outputs.flatMap((o) => [...o.assets.keys()]))];
  if (units.length === 0) return [];
  const tokens = await describeTokens(asNetwork(treasury.network), units);
  return tokens.map((t) => ({ fieldName: budgetTokenLabel(t), unit: t.unit, decimals: t.decimals }));
}

async function planRow(
  treasury: ImportTreasury,
  context: ImportContext,
  txCbor: string,
  asNewNumbers: ReadonlySet<number>,
): Promise<ChainImportPlanResult | "skipped"> {
  const record = extractPayoutMetadata(txCbor);
  if (!isRecord(record) || record.src !== METADATA_SRC) return "skipped";
  const fail = (supported: number): ChainImportPlanResult => ({
    ok: false,
    issues: [
      record.v === supported
        ? { code: Code.BadMetadata, detail: "its shape is not one this app writes" }
        : { code: Code.UnsupportedVersion, version: String(record.v) },
    ],
  });
  const outputs = outputsOf(txCbor);
  const shared = { communitySlug: context.communitySlug, treasuryAddress: treasury.address, outputs };

  if (record.t === PAYMENT_METADATA_TYPE || Array.isArray(record.o)) {
    const meta = parsePaymentMetadata(record);
    if (!meta) return fail(PAYMENT_METADATA_VERSION);
    const candidates = await candidateTokens(treasury, context, meta.k, outputs);
    return planPaymentImport({
      ...shared,
      meta,
      tickers: { registry: context.registry, mints: context.mints, candidates },
      siblings: context.siblings,
      memberLabels: await loadMemberLabels(treasury.community_id, outputs.map((o) => o.address)),
    });
  }

  const meta = parsePayoutMetadata(record);
  if (!meta) return fail(PAYOUT_METADATA_VERSION);
  const candidates = await candidateTokens(treasury, context, meta.k, outputs);
  const numbers = [...new Set(meta.p.flatMap(([, tasks]) => tasks.map(([number]) => number)))];
  return planPayoutImport({
    ...shared,
    meta,
    tickers: { registry: context.registry, mints: context.mints, candidates },
    workgroups: context.workgroups,
    aliases: context.aliases,
    existingTasks: await loadTasksByNumber(treasury.community_id, numbers),
    asNewNumbers,
  });
}

type RowOutcome = "imported" | "skipped" | "gone" | ChainImportIssue[];

async function importRow(
  treasury: ImportTreasury,
  context: ImportContext,
  row: ExternalTxRow,
  txCbor: string,
  asNewNumbers: ReadonlySet<number>,
): Promise<RowOutcome> {
  if (resolveTxHash(txCbor) !== row.tx_hash) return [{ code: Code.HashMismatch }];

  let signedAddresses: string[] = [];
  try {
    const witnessed = new Set(witnessKeyHashes(txCbor));
    signedAddresses = context.signers
      .filter((s) => witnessed.has(s.key_hash.toLowerCase()))
      .map((s) => s.wallet_address);
  } catch {
    // Unreadable witnesses only cost the signer list.
  }
  const createdBy = signedAddresses[0] ?? context.ownerWallet ?? context.signers[0]?.wallet_address;
  if (!createdBy) return [{ code: Code.ImportFailed, detail: "the treasury has no signer to attribute it to" }];

  // Planned twice at most: a task created between the plan and the write
  // shows up as a proper number conflict on the second pass.
  for (let attempt = 0; ; attempt++) {
    const planned = await planRow(treasury, context, txCbor, asNewNumbers);
    if (planned === "skipped") return "skipped";
    if (!planned.ok) return planned.issues;
    const result = await importChainTx(row.tx_hash, {
      ...planned.rows,
      treasuryId: treasury.id,
      txCbor,
      signedAddresses,
      createdBy,
      blockTime: row.block_time,
    });
    if (result.status === "imported") return "imported";
    // Someone else imported it first (the cron, another admin).
    if (result.status !== "failed") return "gone";
    const raced = result.code === PgCode.UniqueViolation || result.message.includes("number_conflict");
    if (!raced || attempt > 0) return [{ code: Code.ImportFailed, detail: result.message }];
  }
}

/** Import what can be imported for one treasury; never throws for one row. */
export async function importExternalTxs(
  treasury: ImportTreasury,
  opts: ChainImportOptions = {},
): Promise<ChainImportRunResult> {
  const result: ChainImportRunResult = { imported: [], blocked: [] };
  const candidates = await loadImportCandidates(treasury.id, {
    hashes: opts.hashes,
    limit: opts.limit ?? DEFAULT_LIMIT,
  });
  if (candidates.length === 0) return result;
  const hashes = candidates.map((c) => c.tx_hash);

  let cbors: Map<string, string>;
  try {
    cbors = await txCborBulk(asNetwork(treasury.network), hashes);
  } catch (err) {
    await stampImportChecked(hashes);
    throw err;
  }
  const context = await loadImportContext(treasury);
  const asNewNumbers = new Set(opts.asNewNumbers ?? []);

  for (const row of candidates) {
    try {
      const txCbor = cbors.get(row.tx_hash);
      let outcome: RowOutcome;
      if (txCbor) outcome = await importRow(treasury, context, row, txCbor, asNewNumbers);
      else if (Date.now() - new Date(row.created_at).getTime() > CBOR_GIVE_UP_MS) outcome = [{ code: Code.MissingCbor }];
      else {
        await stampImportChecked([row.tx_hash]);
        continue;
      }
      if (outcome === "imported") result.imported.push(row.tx_hash);
      else if (outcome === "skipped") await markExternalTx(row.tx_hash, ChainImportStatus.Skipped);
      else if (outcome !== "gone") {
        await markExternalTx(row.tx_hash, ChainImportStatus.Blocked, outcome);
        result.blocked.push({ txHash: row.tx_hash, issues: outcome });
      }
    } catch (err) {
      console.error(`chain import of ${row.tx_hash} failed`, err);
      await stampImportChecked([row.tx_hash]).catch(() => {});
    }
  }
  return result;
}
