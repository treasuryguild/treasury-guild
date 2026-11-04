// receipt_history_preview: plan a previous-wallet receipts CSV and, once
// every token and funding name is settled, hand back a draft. draft_confirm
// writes them.
import "server-only";

import { z } from "zod";
import type { ApiCaller } from "@/lib/api/caller";
import { ASSET_UNIT_RE } from "@/lib/api/schemas";
import { formatQuantity } from "@/lib/assets";
import { sha256Hex } from "@/lib/auth/crypto";
import { LEGACY_MAX_CSV_CHARS } from "@/lib/constants";
import {
  deleteAgentImportPayload, importAgentLegacyReceipts, loadAgentImportPayload, storeAgentImportPayload,
} from "@/lib/db/agentImports";
import { loadLegacyWallet, loadLegacyWallets } from "@/lib/db/legacyHistory";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { canonicalJson } from "@/lib/governance/rules";
import { requireLegacyAddressNetwork } from "@/lib/legacyHistory/access";
import { receiptIssueText } from "@/lib/legacyHistory/receiptIssueText";
import { legacyReceiptRpcRows } from "@/lib/legacyHistory/receiptPlan";
import { planAgentReceipts } from "@/lib/legacyHistory/receiptRun";
import type { LegacyReceiptImportPlan } from "@/lib/legacyHistory/receiptTypes";
import { mintDraftToken, type VerifiedDraft } from "@/lib/mcp/draftToken";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { requireImportAdmin } from "./importAdmin";
import { appLink, communityInput } from "./shared";

const receiptInput = z.object({
  community: communityInput,
  csv: z.string().min(1).max(LEGACY_MAX_CSV_CHARS).describe(
    "The receipts CSV exactly as the user gave it (date, token columns, optional source/commitment/note). Do not rewrite amounts or dates.",
  ),
  fileName: z.string().trim().min(1).max(255).optional(),
  tickerUnits: z.record(
    z.string().trim().min(1).max(32),
    z.string().trim().toLowerCase().regex(ASSET_UNIT_RE, "Token unit: a policy id + asset name (hex)"),
  ).optional().describe("Ticker → unit, only after the user identifies the token. Never invent one."),
  sourceMap: z.record(z.string().trim().min(1).max(80), z.string().uuid()).optional()
    .describe("CSV source name (normalized) → funding source id when several match"),
  commitmentMap: z.record(z.string().trim().min(1).max(200), z.string().uuid()).optional()
    .describe("`sourceId|commitmentRef` → commitment id when several match"),
  legacyWalletId: z.string().uuid().optional().describe("An existing previous wallet"),
  walletName: z.string().trim().min(1).max(64).optional().describe("Name of a previous wallet to create"),
  walletAddress: z.string().trim().min(1).max(200).optional().describe("Optional address label. Never read on chain."),
  includeDuplicates: z.boolean().optional(),
}).refine((v) => !(v.legacyWalletId && v.walletName), { message: "Give a previous wallet's id or a name to create, not both" })
  .refine((v) => !v.walletAddress || v.walletName, { message: "An address belongs to the previous wallet being created" });

interface StoredReceipt {
  tickerUnits: Record<string, string>;
  sourceMap: Record<string, string>;
  commitmentMap: Record<string, string>;
  legacyWalletId: string | null;
  wallet: { name: string; address: string | null } | null;
  fileName: string;
  includeDuplicates: boolean;
}

const storedReceipt = z.object({
  tickerUnits: z.record(z.string(), z.string()),
  sourceMap: z.record(z.string(), z.string()),
  commitmentMap: z.record(z.string(), z.string()),
  legacyWalletId: z.string().nullable(),
  wallet: z.object({ name: z.string(), address: z.string().nullable() }).nullable(),
  fileName: z.string(),
  includeDuplicates: z.boolean(),
});

interface Question { column: string | null; message: string }

function fileNameOf(name: string | undefined): string {
  const file = name?.trim() || "receipts.csv";
  return file.toLowerCase().endsWith(".csv") ? file : `${file}.csv`;
}

function showPlan(plan: LegacyReceiptImportPlan) {
  return {
    counts: plan.counts,
    totals: plan.totals.map((t) => ({
      unit: t.unit,
      ticker: t.ticker,
      decimals: t.decimals,
      amount: t.amount,
      display: formatQuantity(BigInt(t.amount), t.decimals),
    })),
    issues: plan.issues.map((i) => ({ ...i, text: receiptIssueText(i) })),
    sources: plan.sources,
    commitments: plan.commitments,
    tickers: plan.tickers,
  };
}

function receiptFingerprint(plan: LegacyReceiptImportPlan, stored: StoredReceipt): string {
  return sha256Hex(canonicalJson({
    rows: legacyReceiptRpcRows(plan, stored.includeDuplicates),
    wallet: stored.legacyWalletId ?? stored.wallet,
    includeDuplicates: stored.includeDuplicates,
  }));
}

async function planStored(communityId: string, csv: string, stored: StoredReceipt) {
  const plan = await planAgentReceipts({
    communityId,
    walletId: stored.legacyWalletId,
    csv,
    tickerUnits: stored.tickerUnits,
    sourceMap: stored.sourceMap,
    commitmentMap: stored.commitmentMap,
    includeDuplicates: stored.includeDuplicates,
    now: new Date(),
  });
  const questions: Question[] = [];
  for (const t of plan.tickers) {
    if (t.status === "ambiguous") {
      questions.push({
        column: t.ticker,
        message: `Several tokens use ticker ${t.ticker}. Give tickerUnits.${t.ticker} as one of: ${t.candidates.map((c) => c.unit).join(", ")}.`,
      });
    } else if (t.status === "unknown") {
      questions.push({
        column: t.ticker,
        message: `No token matches ticker ${t.ticker}. Ask the user for its unit (policy id + asset name, hex) and pass tickerUnits.${t.ticker}.`,
      });
    }
  }
  for (const s of plan.sources) {
    if (s.status === "missing") {
      questions.push({
        column: null,
        message: `Funding source "${s.name}" does not exist. Create it on the Funding page, or fix the name in the CSV.`,
      });
    } else if (s.status === "ambiguous") {
      questions.push({
        column: null,
        message: `Several funding sources match "${s.name}". Pass sourceMap["${s.ref}"] as one of: ${s.candidates.map((c) => `${c.name} (${c.id})`).join(", ")}.`,
      });
    }
  }
  for (const c of plan.commitments) {
    if (c.status === "missing") {
      questions.push({
        column: null,
        message: `Commitment "${c.name}" could not be matched under its funding source. Create it on the Funding page or fix the CSV.`,
      });
    } else if (c.status === "ambiguous") {
      questions.push({
        column: null,
        message: `Several commitments match "${c.name}". Pass commitmentMap with key sourceId|${c.ref} as one of: ${c.candidates.map((x) => `${x.name} (${x.id})`).join(", ")}.`,
      });
    }
  }
  return { plan, questions };
}

export const previewReceiptHistory = defineEndpoint({
  scope: "imports:write",
  input: receiptInput,
  async run(caller, input) {
    const community = await requireImportAdmin(caller, input.community);
    await enforceRateLimit("legacyHistory", caller.wallet);
    const wallets = (await loadLegacyWallets(community.id)).map((w) => ({ id: w.id, name: w.name }));
    const url = appLink(routes.paymentHistory(community.slug));

    if (input.walletAddress) await requireLegacyAddressNetwork(community.id, input.walletAddress);
    let legacyWalletId: string | null = null;
    let wallet: StoredReceipt["wallet"] = null;
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
        wallet = { name: input.walletName.trim(), address: input.walletAddress ?? null };
      }
    } else {
      const existing = wallets.length ? ` Existing wallets: ${wallets.map((w) => `${w.name} (${w.id})`).join(", ")}.` : "";
      questions.push({ column: null, message: `Which previous wallet is this file for? Give walletName to create one, or legacyWalletId of one that exists.${existing}` });
    }

    const stored: StoredReceipt = {
      tickerUnits: input.tickerUnits ?? {},
      sourceMap: input.sourceMap ?? {},
      commitmentMap: input.commitmentMap ?? {},
      legacyWalletId,
      wallet,
      fileName: fileNameOf(input.fileName),
      includeDuplicates: input.includeDuplicates ?? false,
    };
    const planned = await planStored(community.id, input.csv, stored);
    questions.push(...planned.questions);

    const body = {
      ...showPlan(planned.plan),
      wallet: legacyWalletId ? { id: legacyWalletId } : wallet ? { ...wallet, create: true as const } : null,
      wallets,
      url,
    };
    if (questions.length > 0 || !planned.plan.ready || (!legacyWalletId && !wallet)) {
      return { ready: false, ...body, questions: questions.slice(0, 30) };
    }
    const payload = await storeAgentImportPayload({
      communityId: community.id, wallet: caller.wallet, kind: "legacy_receipts", csv: input.csv, mapping: stored,
    });
    const draft = await mintDraftToken(caller, {
      action: "legacy_receipts_import",
      community: community.slug,
      request: { payloadId: payload.id },
      fingerprint: receiptFingerprint(planned.plan, stored),
      rulesHash: "",
    });
    return { ready: true, ...body, questions: [], draftToken: draft.token, expiresAt: draft.expiresAt };
  },
});

async function replayReceipts(caller: ApiCaller, draft: VerifiedDraft, communityId: string, slug: string): Promise<object> {
  try {
    const result = await importAgentLegacyReceipts({
      draftId: draft.draftId,
      communityId,
      actor: caller.wallet,
      fileName: "receipts.csv",
      legacyWalletId: null,
      walletName: null,
      walletAddress: null,
      rows: [],
      skipExisting: true,
    });
    return { ...result, url: appLink(routes.paymentHistory(slug)) };
  } catch (err) {
    if (err instanceof ConflictError) throw new BadRequestError("This draft is not valid or has expired: preview it again");
    throw err;
  }
}

export async function confirmLegacyReceiptsImport(caller: ApiCaller, draft: VerifiedDraft): Promise<object> {
  const community = await requireImportAdmin(caller, draft.community);
  await enforceRateLimit("legacyHistory", caller.wallet);
  const payloadId = draft.request.payloadId;
  if (typeof payloadId !== "string") throw new BadRequestError("This draft is not valid: preview it again");
  const payload = await loadAgentImportPayload(payloadId);
  if (!payload) return replayReceipts(caller, draft, community.id, community.slug);
  if (payload.kind !== "legacy_receipts" || payload.community_id !== community.id || payload.wallet !== caller.wallet) {
    throw new BadRequestError("This draft is not valid or has expired: preview it again");
  }
  if (Date.parse(payload.expires_at) <= Date.now()) {
    throw new BadRequestError("This draft is not valid or has expired: preview it again");
  }
  const parsed = storedReceipt.safeParse(payload.mapping);
  if (!parsed.success) throw new BadRequestError("This draft is not valid: preview it again");
  const stored = parsed.data;
  if (stored.wallet?.address) await requireLegacyAddressNetwork(community.id, stored.wallet.address);
  const planned = await planStored(community.id, payload.csv, stored);
  if (planned.questions.length > 0 || !planned.plan.ready || receiptFingerprint(planned.plan, stored) !== draft.fingerprint) {
    throw new ConflictError("The import changed since the preview. Preview it again.");
  }
  const result = await importAgentLegacyReceipts({
    draftId: draft.draftId,
    communityId: community.id,
    actor: caller.wallet,
    fileName: stored.fileName,
    legacyWalletId: stored.legacyWalletId,
    walletName: stored.wallet?.name ?? null,
    walletAddress: stored.wallet?.address ?? null,
    rows: legacyReceiptRpcRows(planned.plan, stored.includeDuplicates),
    skipExisting: !stored.includeDuplicates,
  });
  await deleteAgentImportPayload(payload.id);
  return { ...result, url: appLink(routes.paymentHistory(community.slug)) };
}
