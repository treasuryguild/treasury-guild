// Plan an uploaded receipts CSV against the community as it is now. Shared by
// the preview and the import route so what an admin previewed is what gets written.
import "server-only";

import { createHash } from "node:crypto";
import { asNetwork } from "@/lib/config";
import { describeKnownTokens, fetchWalletAssets } from "@/lib/cardano/walletAssets";
import { loadLegacyReceiptImportContext } from "@/lib/db/legacyHistory";
import { errorMessage, UpstreamError } from "@/lib/errors";
import type { MatchableToken } from "@/lib/tokenMatch";
import { resolveLegacyTicker, type TickerContext } from "./plan";
import { readReceiptsCsv } from "./receiptParse";
import { planLegacyReceipts } from "./receiptPlan";
import type { LegacyReceiptImportPlan, LegacyToken } from "./receiptTypes";

export interface LegacyReceiptUpload {
  communityId: string;
  walletId: string;
  csv: string;
  tickerUnits: Record<string, string>;
  /** CSV source ref → funding source id. */
  sourceMap: Record<string, string>;
  /** `${sourceId}|${commitmentRef}` → commitment id. */
  commitmentMap: Record<string, string>;
  replaceImportId: string | null;
  includeDuplicates: boolean;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function sha256(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function planReceipts(
  upload: Omit<LegacyReceiptUpload, "walletId"> & { walletId: string | null },
): Promise<LegacyReceiptImportPlan> {
  const ctx = await loadLegacyReceiptImportContext(upload.communityId, upload.walletId, upload.replaceImportId);
  const network = asNetwork(ctx.network);
  const parsed = readReceiptsCsv(upload.csv, new Date(upload.now.getTime() + DAY_MS).toISOString().slice(0, 10));

  const chosen = Object.entries(upload.tickerUnits);
  let described = new Map<string, { ticker: string | null; decimals: number }>();
  if (chosen.length > 0) {
    try {
      described = await describeKnownTokens(network, [...new Set(chosen.map(([, unit]) => unit))]);
    } catch (err) {
      throw new UpstreamError(`Could not look up the chosen tokens: ${errorMessage(err, "chain provider error")}`);
    }
  }
  const manual = new Map(chosen.map(([ticker, unit]) => {
    const token = described.get(unit);
    const found: LegacyToken | null = token ? { unit, ticker: token.ticker ?? ticker, decimals: token.decimals } : null;
    return [ticker.toLowerCase(), { unit, token: found }] as const;
  }));

  const tickers: TickerContext = { registry: ctx.registry, manual, history: ctx.history, wallet: [] };
  const open = parsed.tickers.some((t) => resolveLegacyTicker(t, tickers).status !== "resolved");
  const wallet: MatchableToken[] = [];
  if (open) {
    const held = await Promise.all(ctx.treasuryAddresses.map((address) =>
      fetchWalletAssets(network, address).then((assets) => assets.tokens, () => [])));
    const seen = new Set<string>();
    for (const token of held.flat()) {
      if (seen.has(token.unit)) continue;
      seen.add(token.unit);
      wallet.push({ unit: token.unit, ticker: token.ticker, decimals: token.decimals });
    }
  }

  return planLegacyReceipts(parsed, {
    ...tickers,
    wallet,
    sources: ctx.sources,
    commitments: ctx.commitments,
    sourceAliases: new Map(Object.entries(upload.sourceMap)),
    commitmentAliases: new Map(Object.entries(upload.commitmentMap)),
    existingKeys: ctx.existingKeys,
    hash: sha256,
    includeDuplicates: upload.includeDuplicates,
  });
}

export async function planLegacyReceiptUpload(upload: LegacyReceiptUpload): Promise<LegacyReceiptImportPlan> {
  return planReceipts(upload);
}

export interface AgentReceiptPlan {
  communityId: string;
  walletId: string | null;
  csv: string;
  tickerUnits: Record<string, string>;
  sourceMap: Record<string, string>;
  commitmentMap: Record<string, string>;
  includeDuplicates: boolean;
  now: Date;
}

export async function planAgentReceipts(plan: AgentReceiptPlan): Promise<LegacyReceiptImportPlan> {
  return planReceipts({
    communityId: plan.communityId,
    walletId: plan.walletId,
    csv: plan.csv,
    tickerUnits: plan.tickerUnits,
    sourceMap: plan.sourceMap,
    commitmentMap: plan.commitmentMap,
    replaceImportId: null,
    includeDuplicates: plan.includeDuplicates,
    now: plan.now,
  });
}
