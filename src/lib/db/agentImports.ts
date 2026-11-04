// The CSV an assistant previewed, kept until the confirm or for fifteen
// minutes (migration 0093). Service role only: it holds the file the admin
// handed over, address endings included.
import "server-only";

import { PgCode } from "@/lib/constants";
import { ConflictError } from "@/lib/errors";
import { DRAFT_TOKEN_TTL_SECONDS } from "@/lib/mcp/draftToken";
import type { LegacyReceiptRpcRow } from "@/lib/legacyHistory/receiptTypes";
import type { LegacyRpcRow } from "@/lib/legacyHistory/types";
import type { FundingAmount } from "./types";
import { maybe, must, rpc, serviceClient } from "./client";

export type AgentImportKind = "legacy_history" | "funding_schedule" | "legacy_receipts";

export interface AgentImportPayload {
  id: string;
  community_id: string;
  wallet: string;
  kind: AgentImportKind;
  csv: string;
  mapping: unknown;
  expires_at: string;
}

const COLUMNS = "id, community_id, wallet, kind, csv, mapping, expires_at";

export async function storeAgentImportPayload(row: {
  communityId: string;
  wallet: string;
  kind: AgentImportKind;
  csv: string;
  mapping: unknown;
}): Promise<{ id: string; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + DRAFT_TOKEN_TTL_SECONDS * 1000).toISOString();
  const stored = must<{ id: string }>(
    await serviceClient()
      .from("agent_import_payloads")
      .insert({
        community_id: row.communityId,
        wallet: row.wallet,
        kind: row.kind,
        csv: row.csv,
        mapping: row.mapping,
        expires_at: expiresAt,
      })
      .select("id")
      .single(),
    "store import preview",
  );
  return { id: stored.id, expiresAt };
}

export async function loadAgentImportPayload(id: string): Promise<AgentImportPayload | null> {
  return maybe<AgentImportPayload>(
    await serviceClient().from("agent_import_payloads").select(COLUMNS).eq("id", id).maybeSingle(),
    "load import preview",
  );
}

export async function deleteAgentImportPayload(id: string): Promise<void> {
  await serviceClient().from("agent_import_payloads").delete().eq("id", id);
}

/** Expired previews (reconcile sweep). */
export async function purgeAgentImportPayloads(now: Date): Promise<number> {
  return rpc<number>(await serviceClient().rpc("purge_agent_import_payloads", { p_now: now.toISOString() }));
}

export interface AgentHistoryWrite {
  draftId: string;
  communityId: string;
  actor: string;
  fileName: string;
  legacyWalletId: string | null;
  walletName: string | null;
  walletAddress: string | null;
  workgroups: { ref: string; action: "create" | "map"; workgroupId?: string; displayName?: string }[];
  rows: LegacyRpcRow[];
  skipExisting: boolean;
}

export interface AgentHistoryWriteResult {
  importId: string;
  legacyWalletId: string;
  inserted: number;
  skipped: number;
  created: boolean;
}

export async function importAgentLegacyHistory(args: AgentHistoryWrite): Promise<AgentHistoryWriteResult> {
  return rpc<AgentHistoryWriteResult>(
    await serviceClient().rpc("import_agent_legacy_history", {
      p_draft_id: args.draftId,
      p_community_id: args.communityId,
      p_actor: args.actor,
      p_file_name: args.fileName,
      p_legacy_wallet_id: args.legacyWalletId,
      p_wallet_name: args.walletName,
      p_wallet_address: args.walletAddress,
      p_workgroups: args.workgroups,
      p_rows: args.rows,
      p_skip_existing: args.skipExisting,
    }),
    { [PgCode.UniqueViolation]: ConflictError },
  );
}

export interface AgentReceiptWrite {
  draftId: string;
  communityId: string;
  actor: string;
  fileName: string;
  legacyWalletId: string | null;
  walletName: string | null;
  walletAddress: string | null;
  rows: LegacyReceiptRpcRow[];
  skipExisting: boolean;
}

export async function importAgentLegacyReceipts(args: AgentReceiptWrite): Promise<AgentHistoryWriteResult> {
  return rpc<AgentHistoryWriteResult>(
    await serviceClient().rpc("import_agent_legacy_receipts", {
      p_draft_id: args.draftId,
      p_community_id: args.communityId,
      p_actor: args.actor,
      p_file_name: args.fileName,
      p_legacy_wallet_id: args.legacyWalletId,
      p_wallet_name: args.walletName,
      p_wallet_address: args.walletAddress,
      p_rows: args.rows,
      p_skip_existing: args.skipExisting,
    }),
    { [PgCode.UniqueViolation]: ConflictError },
  );
}

export interface AgentScheduleWrite {
  draftId: string;
  communityId: string;
  actor: string;
  sourceId: string | null;
  sourceName: string | null;
  sourceDescription: string | null;
  sourceUrl: string | null;
  commitmentId: string | null;
  commitmentName: string | null;
  cadence: "monthly" | "quarterly";
  periods: { startsOn: string; amounts: FundingAmount[] }[];
}

export interface AgentScheduleWriteResult {
  commitmentId: string;
  sourceId: string;
  periods: number;
  created: boolean;
}

export async function importAgentFundingSchedule(args: AgentScheduleWrite): Promise<AgentScheduleWriteResult> {
  return rpc<AgentScheduleWriteResult>(
    await serviceClient().rpc("import_agent_funding_schedule", {
      p_draft_id: args.draftId,
      p_community_id: args.communityId,
      p_actor: args.actor,
      p_source_id: args.sourceId,
      p_source_name: args.sourceName,
      p_source_description: args.sourceDescription,
      p_source_url: args.sourceUrl,
      p_commitment_id: args.commitmentId,
      p_commitment_name: args.commitmentName,
      p_cadence: args.cadence,
      p_periods: args.periods,
    }),
    { [PgCode.UniqueViolation]: ConflictError },
  );
}
