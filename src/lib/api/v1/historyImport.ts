// payment_history_preview: map a CSV onto the payment-history importer and,
// once every column, token and workgroup is settled, hand back a draft. The
// cells are never rewritten. draft_confirm writes them.
import "server-only";

import { z } from "zod";
import type { ApiCaller } from "@/lib/api/caller";
import { ASSET_UNIT_RE } from "@/lib/api/schemas";
import { formatQuantity } from "@/lib/assets";
import { sha256Hex } from "@/lib/auth/crypto";
import { LEGACY_MAX_CSV_CHARS, LegacyIssueCode, ProposalKind } from "@/lib/constants";
import {
  deleteAgentImportPayload, loadAgentImportPayload, storeAgentImportPayload,
} from "@/lib/db/agentImports";
import { loadLegacyImportByDraft, stageAgentLegacyHistory } from "@/lib/legacyHistory/agentConfirm";
import { loadGovernanceSettings } from "@/lib/db/governance";
import { loadLegacyImportContext, loadLegacyWallet, loadLegacyWallets } from "@/lib/db/legacyHistory";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { canonicalJson } from "@/lib/governance/rules";
import { requireLegacyAddressNetwork } from "@/lib/legacyHistory/access";
import { applyWorkgroupDecisions, type WorkgroupDecision } from "@/lib/legacyHistory/decisions";
import { legacyIssueText } from "@/lib/legacyHistory/issueText";
import { applyHistoryColumnMap, type HistoryColumnMap } from "@/lib/legacyHistory/map";
import { legacyRpcRows } from "@/lib/legacyHistory/plan";
import { planAgentHistory } from "@/lib/legacyHistory/run";
import type { LegacyImportPlan } from "@/lib/legacyHistory/types";
import { mintDraftToken, type VerifiedDraft } from "@/lib/mcp/draftToken";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { requireImportAdmin } from "./importAdmin";
import { appLink, communityInput } from "./shared";

const columnMap = z.object({
  recipient: z.number().int().min(0).max(500).describe("Column index of the receiver's address or its last 6+ characters"),
  task: z.number().int().min(0).max(500),
  date: z.number().int().min(0).max(500),
  workgroup: z.number().int().min(0).max(500),
  txHash: z.number().int().min(0).max(500),
  outputIndex: z.number().int().min(0).max(500),
  amounts: z.array(z.object({
    index: z.number().int().min(0).max(500),
    ticker: z.string().trim().min(1).max(32).describe("Ticker this column is paid in, such as ADA"),
  })).max(20),
  skip: z.array(z.number().int().min(0).max(500)).max(50).default([]),
});

const decisionInput = z.object({
  ref: z.string().trim().min(1).max(80).describe("The workgroup name from the CSV"),
  action: z.enum(["create", "map"]),
  workgroupId: z.string().uuid().optional().describe("Required when action is map"),
  displayName: z.string().trim().min(1).max(100).optional(),
}).refine((d) => d.action !== "map" || !!d.workgroupId, { message: "Map a workgroup by its id" });

const historyInput = z.object({
  community: communityInput,
  csv: z.string().min(1).max(LEGACY_MAX_CSV_CHARS).describe(
    "The CSV exactly as the user gave it. Do not rewrite amounts, dates or addresses; map columns instead.",
  ),
  fileName: z.string().trim().min(1).max(255).optional(),
  columns: columnMap.optional().describe("Which column is the receiver, task, date, workgroup and each token. Omit on the first call."),
  tickerUnits: z.record(
    z.string().trim().min(1).max(32),
    z.string().trim().toLowerCase().regex(ASSET_UNIT_RE, "Token unit: a policy id + asset name (hex)"),
  ).optional().describe("Ticker → unit, only after the user identifies the token. Never invent one."),
  workgroups: z.array(decisionInput).max(50).optional()
    .describe("How to settle a workgroup name the community does not have: create, or map to an existing id"),
  legacyWalletId: z.string().uuid().optional().describe("An existing previous wallet"),
  walletName: z.string().trim().min(1).max(64).optional().describe("Name of a previous wallet to create"),
  walletAddress: z.string().trim().min(1).max(200).optional()
    .describe("Shelley address of the previous wallet being created (required with walletName)."),
  includeDuplicates: z.boolean().optional().describe("Also import lines this wallet already holds, when the user says they are separate payments"),
}).refine((v) => !(v.legacyWalletId && v.walletName), { message: "Give a previous wallet's id or a name to create, not both" })
  .refine((v) => !v.walletName || !!v.walletAddress?.trim(), { message: "Give the previous wallet's address when creating one" })
  .refine((v) => !v.walletAddress || v.walletName, { message: "An address belongs to the previous wallet being created" });

interface StoredHistory {
  columns: HistoryColumnMap;
  tickerUnits: Record<string, string>;
  workgroups: WorkgroupDecision[];
  legacyWalletId: string | null;
  wallet: { name: string; address: string } | null;
  fileName: string;
  includeDuplicates: boolean;
}

const storedHistory = z.object({
  columns: columnMap,
  tickerUnits: z.record(z.string(), z.string()),
  workgroups: z.array(z.object({
    ref: z.string(),
    action: z.enum(["create", "map"]),
    workgroupId: z.string().optional(),
    displayName: z.string().optional(),
  })),
  legacyWalletId: z.string().nullable(),
  wallet: z.object({ name: z.string(), address: z.string() }).nullable(),
  fileName: z.string(),
  includeDuplicates: z.boolean(),
});

interface Question { column: string | null; message: string }

function fileNameOf(name: string | undefined): string {
  const file = name?.trim() || "history.csv";
  if (new TextEncoder().encode(file).length > 255) throw new BadRequestError("The file name is too long");
  return file;
}

function historyFingerprint(plan: LegacyImportPlan, stored: StoredHistory): string {
  const lines = plan.rows
    .filter((row) => row.dedupeKey && (row.status === "new" || (row.status === "duplicate" && stored.includeDuplicates)))
    .map((row) => `${row.dedupeKey}:${row.budgetMonth}`)
    .sort();
  return sha256Hex(canonicalJson({
    fileName: stored.fileName,
    includeDuplicates: stored.includeDuplicates,
    wallet: stored.legacyWalletId ?? stored.wallet,
    workgroups: [...stored.workgroups].sort((a, b) => a.ref.localeCompare(b.ref)),
    counts: plan.counts,
    totals: [...plan.totals].map((t) => ({ workgroupId: t.workgroupId, unit: t.unit, amount: t.amount })).sort((a, b) =>
      `${a.workgroupId ?? ""}:${a.unit}`.localeCompare(`${b.workgroupId ?? ""}:${b.unit}`)),
    lines,
  }));
}

function planQuestions(plan: LegacyImportPlan): Question[] {
  const questions: Question[] = [];
  for (const ticker of plan.tickers) {
    if (ticker.status === "ambiguous") {
      const choices = ticker.candidates.map((c) => `${c.ticker} (${c.unit})`).join("; ");
      questions.push({ column: ticker.ticker, message: `${ticker.ticker} matches more than one token: ${choices}. Ask which unit. Do not guess.` });
    } else if (ticker.status === "unknown") {
      questions.push({
        column: ticker.ticker,
        message: `No known token has the ticker ${ticker.ticker}. Ask the user for its unit (policy id followed by the asset name, in hex). Do not invent one.`,
      });
    }
  }
  for (const group of plan.workgroups) {
    if (group.status === "missing") {
      questions.push({ column: group.name, message: `No workgroup matches "${group.name}". Create it, or map it to an existing workgroup, archived ones included.` });
    } else if (group.status === "ambiguous") {
      questions.push({ column: group.name, message: `"${group.name}" matches more than one workgroup: ${group.candidates.map((c) => c.name).join(", ")}. Ask which one.` });
    }
  }
  for (const issue of plan.issues) {
    if (issue.severity !== "error") continue;
    if (issue.code === LegacyIssueCode.UnresolvedTicker || issue.code === LegacyIssueCode.UnresolvedWorkgroup) continue;
    const text = legacyIssueText(issue);
    questions.push({ column: issue.column ?? null, message: issue.line ? `Line ${issue.line}: ${text}` : text });
  }
  return questions;
}

async function planStored(
  communityId: string,
  csv: string,
  stored: StoredHistory,
): Promise<{ plan: LegacyImportPlan; questions: Question[]; applied: WorkgroupDecision[] }> {
  const mapped = applyHistoryColumnMap(csv, stored.columns);
  if (!mapped.csv) throw new ConflictError("The import changed since the preview. Preview it again.");
  const governance = await loadGovernanceSettings(communityId, ProposalKind.Workgroup);
  const ctx = await loadLegacyImportContext(communityId, stored.legacyWalletId, null);
  const decided = applyWorkgroupDecisions(ctx.workgroups, ctx.aliases, stored.workgroups, governance.enabled);
  const walletAddress = stored.legacyWalletId
    ? ctx.walletAddress
    : stored.wallet?.address ?? null;
  const plan = await planAgentHistory({
    communityId,
    walletId: stored.legacyWalletId,
    csv: mapped.csv,
    tickerUnits: stored.tickerUnits,
    includeDuplicates: stored.includeDuplicates,
    now: new Date(),
    workgroups: decided.workgroups,
    aliases: decided.aliases,
    walletAddress,
  });
  return {
    plan,
    applied: decided.applied,
    questions: [...decided.questions.map((q) => ({ column: q.ref, message: q.message })), ...planQuestions(plan)],
  };
}

function showPlan(plan: LegacyImportPlan) {
  const names = new Map(plan.workgroups.flatMap((w) => w.status === "resolved" ? [[w.workgroup.id, w.workgroup.name] as const] : []));
  return {
    counts: plan.counts,
    totals: plan.totals.map((t) => ({
      workgroup: t.workgroupId === null ? null : names.get(t.workgroupId) ?? t.workgroupId,
      ticker: t.ticker,
      amount: formatQuantity(BigInt(t.amount), t.decimals),
    })),
    tokens: plan.tickers.map((t) => t.status === "resolved"
      ? { ticker: t.ticker, status: t.status, unit: t.unit }
      : { ticker: t.ticker, status: t.status }),
    workgroups: plan.workgroups.map((w) => ({
      name: w.name,
      status: w.status,
      workgroup: w.status === "resolved" ? w.workgroup.name : null,
      archived: w.status === "resolved" ? w.workgroup.archived : false,
    })),
    warnings: plan.issues.filter((i) => i.severity === "warning").slice(0, 20).map((i) =>
      (i.line ? `Line ${i.line}: ` : "") + legacyIssueText(i)),
  };
}

export const previewPaymentHistory = defineEndpoint({
  scope: "imports:write",
  input: historyInput,
  async run(caller, input) {
    const community = await requireImportAdmin(caller, input.community);
    await enforceRateLimit("legacyHistory", caller.wallet);
    const mapped = applyHistoryColumnMap(input.csv, input.columns ?? null);
    const wallets = (await loadLegacyWallets(community.id)).map((w) => ({ id: w.id, name: w.name }));
    const url = appLink(routes.paymentHistory(community.slug));
    if (!mapped.csv) {
      return { ready: false, headers: mapped.headers, mapping: mapped.suggested, questions: mapped.questions.slice(0, 30), wallets, url };
    }

    if (input.walletAddress) await requireLegacyAddressNetwork(community.id, input.walletAddress);
    let legacyWalletId: string | null = null;
    let wallet: StoredHistory["wallet"] = null;
    const questions: Question[] = [];
    if (input.legacyWalletId) {
      const row = await loadLegacyWallet(input.legacyWalletId);
      if (!row || row.community_id !== community.id) throw new NotFoundError("Previous wallet not found");
      legacyWalletId = row.id;
    } else if (input.walletName) {
      const taken = wallets.find((w) => w.name.trim().toLowerCase() === input.walletName!.trim().toLowerCase());
      if (taken) {
        questions.push({ column: null, message: `A previous wallet named "${taken.name}" already exists (${taken.id}). Use that id, or choose another name.` });
      } else {
        wallet = { name: input.walletName.trim(), address: input.walletAddress!.trim() };
      }
    } else {
      const existing = wallets.length ? ` Existing wallets: ${wallets.map((w) => `${w.name} (${w.id})`).join(", ")}.` : "";
      questions.push({ column: null, message: `Which previous wallet is this file for? Give walletName to create one, or legacyWalletId of one that exists.${existing}` });
    }

    const stored: StoredHistory = {
      columns: columnMap.parse(mapped.suggested),
      tickerUnits: input.tickerUnits ?? {},
      workgroups: input.workgroups ?? [],
      legacyWalletId,
      wallet,
      fileName: fileNameOf(input.fileName),
      includeDuplicates: input.includeDuplicates ?? false,
    };
    const planned = await planStored(community.id, input.csv, stored);
    stored.workgroups = planned.applied;
    questions.push(...planned.questions);

    const body = {
      headers: mapped.headers,
      mapping: stored.columns,
      ...showPlan(planned.plan),
      wallet: legacyWalletId ? { id: legacyWalletId } : wallet ? { ...wallet, create: true as const } : null,
      wallets,
      url,
    };
    if (questions.length > 0 || !planned.plan.ready || (!legacyWalletId && !wallet)) {
      return { ready: false, ...body, questions: questions.slice(0, 30) };
    }
    const payload = await storeAgentImportPayload({
      communityId: community.id, wallet: caller.wallet, kind: "legacy_history", csv: input.csv, mapping: stored,
    });
    const draft = await mintDraftToken(caller, {
      action: "legacy_history_import",
      community: community.slug,
      request: { payloadId: payload.id },
      fingerprint: historyFingerprint(planned.plan, stored),
      rulesHash: "",
    });
    return { ready: true, ...body, questions: [], draftToken: draft.token, expiresAt: draft.expiresAt };
  },
});

async function replayLegacyHistory(_caller: ApiCaller, draft: VerifiedDraft, communityId: string, slug: string): Promise<object> {
  const existing = await loadLegacyImportByDraft(draft.draftId);
  if (!existing || existing.community_id !== communityId) {
    throw new BadRequestError("This draft is not valid or has expired: preview it again");
  }
  return {
    created: false,
    importId: existing.id,
    legacyWalletId: existing.legacy_wallet_id,
    state: existing.state,
    planHash: existing.plan_hash ?? undefined,
    signatures: 0,
    required: 1,
    inserted: existing.state === "active" ? existing.line_count : undefined,
    skipped: 0,
    url: appLink(routes.paymentHistory(slug)),
  };
}

export async function confirmLegacyHistoryImport(caller: ApiCaller, draft: VerifiedDraft): Promise<object> {
  const community = await requireImportAdmin(caller, draft.community);
  await enforceRateLimit("legacyHistory", caller.wallet);
  const payloadId = draft.request.payloadId;
  if (typeof payloadId !== "string") throw new BadRequestError("This draft is not valid: preview it again");
  const payload = await loadAgentImportPayload(payloadId);
  // A confirm that already wrote deletes its payload. The same draft reads that import back.
  if (!payload) return replayLegacyHistory(caller, draft, community.id, community.slug);
  if (payload.kind !== "legacy_history" || payload.community_id !== community.id || payload.wallet !== caller.wallet) {
    throw new BadRequestError("This draft is not valid or has expired: preview it again");
  }
  if (Date.parse(payload.expires_at) <= Date.now()) {
    throw new BadRequestError("This draft is not valid or has expired: preview it again");
  }
  const parsed = storedHistory.safeParse(payload.mapping);
  if (!parsed.success) throw new BadRequestError("This draft is not valid: preview it again");
  const stored = parsed.data;
  if (stored.wallet?.address) await requireLegacyAddressNetwork(community.id, stored.wallet.address);
  const planned = await planStored(community.id, payload.csv, stored);
  if (planned.questions.length > 0 || !planned.plan.ready || historyFingerprint(planned.plan, stored) !== draft.fingerprint) {
    throw new ConflictError("The import changed since the preview. Preview it again.");
  }
  const result = await stageAgentLegacyHistory({
    draftId: draft.draftId,
    communityId: community.id,
    actor: caller.wallet,
    fileName: stored.fileName,
    legacyWalletId: stored.legacyWalletId,
    walletName: stored.wallet?.name ?? null,
    walletAddress: stored.wallet?.address ?? null,
    workgroups: stored.workgroups,
    rows: legacyRpcRows(planned.plan, stored.includeDuplicates),
    skipExisting: !stored.includeDuplicates,
  });
  await deleteAgentImportPayload(payload.id);
  return { ...result, url: appLink(routes.paymentHistory(community.slug)) };
}
