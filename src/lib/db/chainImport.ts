// Service-role reads and writes of the chain import (src/lib/chainImport):
// the external rows waiting for it, the community state a plan is made
// against, the import_chain_tx RPC and the import state on external_txs.
import "server-only";

import type { AssetDef } from "@/lib/assets";
import { joinUnit } from "@/lib/cardano/units";
import { workgroupNamesToResolve } from "@/lib/chainImport/issueText";
import type { ImportExistingTask, ImportWorkgroup } from "@/lib/chainImport/plan";
import type { ChainImportIssue, ChainImportPlan } from "@/lib/chainImport/types";
import { ChainImportStatus, Role } from "@/lib/constants";
import { loadAssetRegistry } from "./assets";
import { check, maybe, must, rows, serviceClient } from "./client";
import { loadSiblingTreasuries, type SiblingTreasury } from "./payments";
import { EXTERNAL_TX_COLUMNS, type ExternalTxRow } from "./types";

export interface ImportTreasury {
  id: string;
  community_id: string;
  address: string;
  network: number;
}

export async function loadImportTreasury(treasuryId: string): Promise<ImportTreasury | null> {
  return maybe<ImportTreasury>(
    await serviceClient()
      .from("treasuries")
      .select("id, community_id, address, network")
      .eq("id", treasuryId)
      .maybeSingle(),
    "load import treasury",
  );
}

/**
 * External rows to import. Without `hashes`: the ones never evaluated, oldest
 * first so the earlier transaction wins a task number, and the ones that keep
 * failing transiently last. With `hashes` (an admin's action): those rows
 * whatever their state.
 */
export async function loadImportCandidates(
  treasuryId: string,
  opts: { hashes?: string[]; limit: number },
): Promise<ExternalTxRow[]> {
  let query = serviceClient()
    .from("external_txs")
    .select(EXTERNAL_TX_COLUMNS)
    .eq("treasury_id", treasuryId)
    .not("payout_meta", "is", null);
  query = opts.hashes ? query.in("tx_hash", opts.hashes) : query.is("import_status", null);
  return rows<ExternalTxRow>(
    await query
      .order("import_checked_at", { ascending: true, nullsFirst: true })
      .order("block_time", { ascending: true })
      .limit(opts.limit),
    "load import candidates",
  );
}

export async function loadExternalTx(txHash: string): Promise<ExternalTxRow | null> {
  return maybe<ExternalTxRow>(
    await serviceClient().from("external_txs").select(EXTERNAL_TX_COLUMNS).eq("tx_hash", txHash).maybeSingle(),
    "load external tx",
  );
}

/** Blocked rows of a community whose issues name this workgroup. */
export async function loadBlockedByWorkgroup(communityId: string, name: string): Promise<ExternalTxRow[]> {
  // external_txs has two FKs to treasuries, so no embed: filter by id.
  const db = serviceClient();
  const treasuryIds = rows<{ id: string }>(
    await db.from("treasuries").select("id").eq("community_id", communityId),
    "load community treasuries",
  ).map((t) => t.id);
  if (treasuryIds.length === 0) return [];
  const blocked = rows<ExternalTxRow>(
    await db
      .from("external_txs")
      .select(EXTERNAL_TX_COLUMNS)
      .in("treasury_id", treasuryIds)
      .eq("import_status", ChainImportStatus.Blocked),
    "load blocked imports",
  );
  return blocked.filter((row) => workgroupNamesToResolve(row.import_issues).includes(name));
}

/** What a plan is made against; loaded once per treasury and run. */
export interface ImportContext {
  communitySlug: string;
  workgroups: ImportWorkgroup[];
  aliases: Map<string, string>;
  registry: AssetDef[];
  mints: AssetDef[];
  siblings: SiblingTreasury[];
  signers: { wallet_address: string; key_hash: string }[];
  ownerWallet: string | null;
}

export async function loadImportContext(treasury: ImportTreasury): Promise<ImportContext> {
  const db = serviceClient();
  const [community, workgroups, aliases, registry, mints, siblings, signers, owner] = await Promise.all([
    db.from("communities").select("slug").eq("id", treasury.community_id).single(),
    db.from("workgroups").select("id, name, archived_at").eq("community_id", treasury.community_id),
    db.from("workgroup_import_aliases").select("name, workgroup_id").eq("community_id", treasury.community_id),
    loadAssetRegistry(treasury.community_id),
    db.from("mints").select("ticker, policy_id, asset_name_hex, decimals").eq("treasury_id", treasury.id),
    loadSiblingTreasuries(treasury.community_id, treasury.id),
    db.from("treasury_signers").select("wallet_address, key_hash").eq("treasury_id", treasury.id),
    db
      .from("community_members")
      .select("wallet_address")
      .eq("community_id", treasury.community_id)
      .eq("role", Role.Owner)
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    communitySlug: must<{ slug: string }>(community, "load import community").slug,
    workgroups: rows<{ id: string; name: string; archived_at: string | null }>(workgroups, "load import workgroups")
      .map((w) => ({ id: w.id, name: w.name, archivedAt: w.archived_at })),
    aliases: new Map(
      rows<{ name: string; workgroup_id: string }>(aliases, "load workgroup aliases").map((a) => [a.name, a.workgroup_id]),
    ),
    registry,
    mints: rows<{ ticker: string | null; policy_id: string; asset_name_hex: string; decimals: number }>(
      mints,
      "load import mints",
    ).flatMap((m) =>
      m.ticker ? [{ fieldName: m.ticker, unit: joinUnit(m.policy_id, m.asset_name_hex), decimals: m.decimals }] : []),
    siblings,
    signers: rows<{ wallet_address: string; key_hash: string }>(signers, "load import signers"),
    ownerWallet: maybe<{ wallet_address: string }>(owner, "load import owner")?.wallet_address ?? null,
  };
}

interface ExistingTaskRow {
  id: string;
  number: number;
  title: string;
  workgroup_id: string;
  pay_state: string;
  paid_tx_hash: string | null;
  archived_at: string | null;
  amounts: Record<string, string> | null;
  bounty_lovelace: string | number | null;
  task_assignees: { wallet_address: string | null }[];
}

/** The community's tasks carrying any of these numbers. */
export async function loadTasksByNumber(communityId: string, numbers: number[]): Promise<ImportExistingTask[]> {
  if (numbers.length === 0) return [];
  return rows<ExistingTaskRow>(
    await serviceClient()
      .from("tasks")
      .select(
        "id, number, title, workgroup_id, pay_state, paid_tx_hash, archived_at, amounts, bounty_lovelace, task_assignees(wallet_address)",
      )
      .eq("community_id", communityId)
      .in("number", numbers),
    "load tasks by number",
  ).map((t) => ({
    id: t.id,
    number: t.number,
    title: t.title,
    workgroupId: t.workgroup_id,
    payState: t.pay_state,
    paidTxHash: t.paid_tx_hash,
    archivedAt: t.archived_at,
    amounts: t.amounts,
    bountyLovelace: t.bounty_lovelace,
    wallets: t.task_assignees.map((a) => a.wallet_address),
  }));
}

export type ImportRpcResult =
  | { status: "imported"; transactionId: string; numbers: Record<string, number> }
  | { status: "gone" | "already" }
  | { status: "failed"; code: string; message: string };

/** Execute a plan. A database refusal comes back as `failed`, never thrown. */
export async function importChainTx(txHash: string, plan: ChainImportPlan): Promise<ImportRpcResult> {
  const res = await serviceClient().rpc("import_chain_tx", { p_tx_hash: txHash, p_plan: plan });
  if (res.error) return { status: "failed", code: res.error.code, message: res.error.message };
  return res.data as ImportRpcResult;
}

/** Record where a row stands; `status` null leaves it for the next run. */
export async function markExternalTx(
  txHash: string,
  status: ChainImportStatus | null,
  issues: ChainImportIssue[] = [],
): Promise<void> {
  check(
    await serviceClient()
      .from("external_txs")
      .update({ import_status: status, import_issues: issues, import_checked_at: new Date().toISOString() })
      .eq("tx_hash", txHash),
    "mark external tx",
  );
}

/** A transient failure: note the attempt, leave the state for the next run. */
export async function stampImportChecked(txHashes: string[]): Promise<void> {
  if (txHashes.length === 0) return;
  check(
    await serviceClient()
      .from("external_txs")
      .update({ import_checked_at: new Date().toISOString() })
      .in("tx_hash", txHashes),
    "stamp import attempt",
  );
}

export async function upsertWorkgroupAlias(
  communityId: string,
  name: string,
  workgroupId: string,
  wallet: string,
): Promise<void> {
  check(
    await serviceClient()
      .from("workgroup_import_aliases")
      .upsert(
        { community_id: communityId, name, workgroup_id: workgroupId, created_by: wallet },
        { onConflict: "community_id,name" },
      ),
    "save workgroup alias",
  );
}
