// Plan an uploaded payment-history CSV against the community as it is now.
// Shared by the preview and the import route, so what an admin previewed is
// exactly what gets written: the import re-parses the file and never takes
// rows from the browser. Chain verification runs against Koios tx_info.
import "server-only";

import { createHash } from "node:crypto";
import { asNetwork } from "@/lib/config";
import { describeKnownTokens, fetchWalletAssets } from "@/lib/cardano/walletAssets";
import { loadLegacyImportContext } from "@/lib/db/legacyHistory";
import { errorMessage, UpstreamError } from "@/lib/errors";
import type { MatchableToken } from "@/lib/tokenMatch";
import { readHistoryCsv } from "./parse";
import { planLegacyImport, resolveLegacyTicker, type TickerContext } from "./plan";
import type { LegacyImportPlan, LegacyToken, LegacyWorkgroup } from "./types";
import { applyPaymentChainChecks } from "./verifyChain";

export interface LegacyUpload {
  communityId: string;
  walletId: string;
  csv: string;
  /** Ticker → the unit an admin chose for it. */
  tickerUnits: Record<string, string>;
  replaceImportId: string | null;
  includeDuplicates: boolean;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function sha256Hex(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function planHistory(
  upload: Omit<LegacyUpload, "walletId"> & { walletId: string | null },
  patch: {
    workgroups: readonly LegacyWorkgroup[];
    aliases: ReadonlyMap<string, string>;
    walletAddress?: string | null;
  } | null,
): Promise<LegacyImportPlan> {
  const ctx = await loadLegacyImportContext(upload.communityId, upload.walletId, upload.replaceImportId);
  const network = asNetwork(ctx.network);
  const previousWalletAddress = patch?.walletAddress ?? ctx.walletAddress;
  const parsed = readHistoryCsv(upload.csv, new Date(upload.now.getTime() + DAY_MS).toISOString().slice(0, 10));

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

  const plan = planLegacyImport(parsed, {
    ...tickers,
    wallet,
    aliases: patch?.aliases ?? ctx.aliases,
    workgroups: patch?.workgroups ?? ctx.workgroups,
    setups: ctx.setups,
    existingKeys: ctx.existingKeys,
    hash: sha256Hex,
    includeDuplicates: upload.includeDuplicates,
  });

  return applyPaymentChainChecks(plan, {
    network,
    previousWalletAddress,
    alreadyClaimed: ctx.claimedByOutput,
    includeDuplicates: upload.includeDuplicates,
  });
}

export async function planLegacyUpload(upload: LegacyUpload): Promise<LegacyImportPlan> {
  return planHistory(upload, null);
}

export interface AgentHistoryPlan {
  communityId: string;
  /** Null when the confirm will create the previous wallet: nothing is already imported. */
  walletId: string | null;
  csv: string;
  tickerUnits: Record<string, string>;
  includeDuplicates: boolean;
  now: Date;
  /** Workgroups and aliases after the caller's create/map choices, standing in for what the confirm writes. */
  workgroups: readonly LegacyWorkgroup[];
  aliases: ReadonlyMap<string, string>;
  /** Address the confirm will store on the new wallet (required for chain checks). */
  walletAddress: string | null;
}

/** The same plan as an upload, against a wallet that may not exist yet and workgroups the confirm has not created. */
export async function planAgentHistory(plan: AgentHistoryPlan): Promise<LegacyImportPlan> {
  return planHistory({
    communityId: plan.communityId,
    walletId: plan.walletId,
    csv: plan.csv,
    tickerUnits: plan.tickerUnits,
    replaceImportId: null,
    includeDuplicates: plan.includeDuplicates,
    now: plan.now,
  }, {
    workgroups: plan.workgroups,
    aliases: plan.aliases,
    walletAddress: plan.walletAddress,
  });
}
