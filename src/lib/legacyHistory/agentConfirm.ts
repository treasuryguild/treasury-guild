// Agent draft_confirm for previous-wallet imports: persist workgroups, stage
// the batch (pending_signatures), never activate without in-app attestation.
import "server-only";

import { ProposalKind } from "@/lib/constants";
import { check, maybe, serviceClient } from "@/lib/db/client";
import { upsertWorkgroupAlias } from "@/lib/db/chainImport";
import { loadGovernanceSettings } from "@/lib/db/governance";
import {
  createLegacyWallet, loadLegacyWallet, stageLegacyHistory, stageLegacyReceipts,
} from "@/lib/db/legacyHistory";
import {
  LEGACY_IMPORT_COLUMNS, LEGACY_RECEIPT_IMPORT_COLUMNS,
  type LegacyImportRow, type LegacyReceiptImportRow,
} from "@/lib/db/types";
import { createWorkgroupWithBoard, workgroupCommunityId } from "@/lib/db/workgroups";
import { BadRequestError, ConflictError } from "@/lib/errors";
import type { LegacyRpcRow } from "./types";
import type { LegacyReceiptRpcRow } from "./receiptTypes";
import type { WorkgroupDecision } from "./decisions";
import { isPendingWorkgroupId } from "./decisions";
import { normalizeWorkgroupName } from "./parse";
import { legacyPlanHash } from "./plan";
import { sha256Hex } from "./run";
import { signaturesRequiredForWallet } from "./stageUpload";

export async function loadLegacyImportByDraft(draftId: string): Promise<LegacyImportRow | null> {
  return maybe<LegacyImportRow>(
    await serviceClient().from("legacy_imports").select(LEGACY_IMPORT_COLUMNS).eq("agent_draft_id", draftId).maybeSingle(),
    "load history import by draft",
  );
}

export async function loadLegacyReceiptImportByDraft(draftId: string): Promise<LegacyReceiptImportRow | null> {
  return maybe<LegacyReceiptImportRow>(
    await serviceClient().from("legacy_receipt_imports").select(LEGACY_RECEIPT_IMPORT_COLUMNS).eq("agent_draft_id", draftId).maybeSingle(),
    "load receipt import by draft",
  );
}

async function stampAgentDraft(kind: "payments" | "receipts", importId: string, draftId: string): Promise<void> {
  const table = kind === "payments" ? "legacy_imports" : "legacy_receipt_imports";
  check(await serviceClient().from(table).update({ agent_draft_id: draftId }).eq("id", importId), "stamp import draft");
}

async function persistWorkgroupDecisions(
  communityId: string,
  actor: string,
  decisions: readonly WorkgroupDecision[],
): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const governance = await loadGovernanceSettings(communityId, ProposalKind.Workgroup);
  for (const decision of decisions) {
    const ref = normalizeWorkgroupName(decision.ref);
    if (ref === "") throw new BadRequestError("Name the workgroup");
    let target: string;
    if (decision.action === "map") {
      target = decision.workgroupId!;
      if ((await workgroupCommunityId(target)) !== communityId) {
        throw new BadRequestError("That workgroup is not in this community");
      }
    } else {
      if (governance.enabled) {
        throw new BadRequestError(
          "New workgroups need a passed proposal while workgroup governance is on. Map the name to an existing workgroup instead.",
        );
      }
      target = await createWorkgroupWithBoard(communityId, (decision.displayName ?? decision.ref).trim());
    }
    await upsertWorkgroupAlias(communityId, ref, target, actor);
    refs.set(ref, target);
  }
  return refs;
}

function resolveWorkgroupId(row: LegacyRpcRow, refs: Map<string, string>): string {
  const mapped = refs.get(row.workgroupRef);
  if (mapped) return mapped;
  if (!isPendingWorkgroupId(row.workgroupId)) return row.workgroupId;
  throw new BadRequestError("Workgroup decisions from the preview were not applied");
}

function remapPaymentRows(rows: LegacyRpcRow[], refs: Map<string, string>): LegacyRpcRow[] {
  return rows.map((row) => ({ ...row, workgroupId: resolveWorkgroupId(row, refs) }));
}

export interface AgentHistoryStageResult {
  importId: string;
  legacyWalletId: string;
  state: "pending_signatures" | "active";
  planHash: string;
  signatures: number;
  required: number;
  inserted?: number;
  skipped: number;
  created: boolean;
}

export async function stageAgentLegacyHistory(args: {
  draftId: string;
  communityId: string;
  actor: string;
  fileName: string;
  legacyWalletId: string | null;
  walletName: string | null;
  walletAddress: string | null;
  workgroups: WorkgroupDecision[];
  rows: LegacyRpcRow[];
  skipExisting: boolean;
}): Promise<AgentHistoryStageResult> {
  const existing = await loadLegacyImportByDraft(args.draftId);
  if (existing) {
    if (existing.community_id !== args.communityId) throw new ConflictError("This draft belongs to another community");
    const wallet = await loadLegacyWallet(existing.legacy_wallet_id);
    if (!wallet) throw new BadRequestError("Previous wallet not found");
    return {
      importId: existing.id,
      legacyWalletId: existing.legacy_wallet_id,
      state: existing.state,
      planHash: existing.plan_hash ?? "",
      signatures: 0,
      required: signaturesRequiredForWallet(wallet),
      inserted: existing.state === "active" ? existing.line_count : undefined,
      skipped: 0,
      created: false,
    };
  }

  let wallet;
  let created = false;
  if (args.legacyWalletId) {
    wallet = await loadLegacyWallet(args.legacyWalletId);
    if (!wallet || wallet.community_id !== args.communityId) throw new BadRequestError("Previous wallet not found");
  } else {
    const name = args.walletName?.trim();
    const address = args.walletAddress?.trim();
    if (!name) throw new BadRequestError("Name the previous wallet");
    if (!address) throw new BadRequestError("Give the previous wallet's address");
    wallet = await createLegacyWallet({
      community_id: args.communityId,
      name,
      address,
      created_by: args.actor,
    });
    created = true;
  }

  const refs = await persistWorkgroupDecisions(args.communityId, args.actor, args.workgroups);
  const rows = remapPaymentRows(args.rows, refs);
  if (rows.length === 0) throw new BadRequestError("Nothing new to import: every line is already here");

  const planHash = legacyPlanHash(rows, sha256Hex);
  const staged = await stageLegacyHistory({
    walletId: wallet.id,
    fileName: args.fileName,
    actor: args.actor,
    planHash,
    rows,
    replaceImportId: null,
  });
  await stampAgentDraft("payments", staged.importId, args.draftId);

  return {
    importId: staged.importId,
    legacyWalletId: wallet.id,
    state: "pending_signatures",
    planHash: staged.planHash,
    signatures: 0,
    required: signaturesRequiredForWallet(wallet),
    skipped: 0,
    created,
  };
}

export async function stageAgentLegacyReceipts(args: {
  draftId: string;
  communityId: string;
  actor: string;
  fileName: string;
  legacyWalletId: string | null;
  walletName: string | null;
  walletAddress: string | null;
  rows: LegacyReceiptRpcRow[];
  skipExisting: boolean;
}): Promise<AgentHistoryStageResult> {
  const existing = await loadLegacyReceiptImportByDraft(args.draftId);
  if (existing) {
    if (existing.community_id !== args.communityId) throw new ConflictError("This draft belongs to another community");
    const wallet = await loadLegacyWallet(existing.legacy_wallet_id);
    if (!wallet) throw new BadRequestError("Previous wallet not found");
    return {
      importId: existing.id,
      legacyWalletId: existing.legacy_wallet_id,
      state: existing.state,
      planHash: existing.plan_hash ?? "",
      signatures: 0,
      required: signaturesRequiredForWallet(wallet),
      inserted: existing.state === "active" ? existing.line_count : undefined,
      skipped: 0,
      created: false,
    };
  }

  let wallet;
  let created = false;
  if (args.legacyWalletId) {
    wallet = await loadLegacyWallet(args.legacyWalletId);
    if (!wallet || wallet.community_id !== args.communityId) throw new BadRequestError("Previous wallet not found");
  } else {
    const name = args.walletName?.trim();
    const address = args.walletAddress?.trim();
    if (!name) throw new BadRequestError("Name the previous wallet");
    if (!address) throw new BadRequestError("Give the previous wallet's address");
    wallet = await createLegacyWallet({
      community_id: args.communityId,
      name,
      address,
      created_by: args.actor,
    });
    created = true;
  }

  const rows = args.rows;
  if (rows.length === 0) throw new BadRequestError("Nothing new to import: every line is already here");

  const planHash = legacyPlanHash(rows, sha256Hex);
  const staged = await stageLegacyReceipts({
    walletId: wallet.id,
    fileName: args.fileName,
    actor: args.actor,
    planHash,
    rows,
    replaceImportId: null,
  });
  await stampAgentDraft("receipts", staged.importId, args.draftId);

  return {
    importId: staged.importId,
    legacyWalletId: wallet.id,
    state: "pending_signatures",
    planHash: staged.planHash,
    signatures: 0,
    required: signaturesRequiredForWallet(wallet),
    skipped: 0,
    created,
  };
}
