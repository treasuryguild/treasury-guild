// Plan an uploaded payment-history CSV against the community as it is now.
// Shared by the preview and the import route, so what an admin previewed is
// exactly what gets written: the import re-parses the file and never takes
// rows from the browser.
import "server-only";

import { createHash } from "node:crypto";
import { asNetwork } from "@/lib/config";
import { describeKnownTokens, fetchWalletAssets } from "@/lib/cardano/walletAssets";
import { loadLegacyImportContext } from "@/lib/db/legacyHistory";
import { errorMessage, UpstreamError } from "@/lib/errors";
import type { MatchableToken } from "@/lib/tokenMatch";
import { readHistoryCsv } from "./parse";
import { planLegacyImport, resolveLegacyTicker, type TickerContext } from "./plan";
import type { LegacyImportPlan, LegacyToken } from "./types";

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

function sha256(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export async function planLegacyUpload(upload: LegacyUpload): Promise<LegacyImportPlan> {
  const ctx = await loadLegacyImportContext(upload.communityId, upload.walletId, upload.replaceImportId);
  const network = asNetwork(ctx.network);
  // A day of slack: "today" where the admin is may already be tomorrow in UTC.
  const parsed = readHistoryCsv(upload.csv, new Date(upload.now.getTime() + DAY_MS).toISOString().slice(0, 10));

  // An admin's unit counts only once the chain confirms the asset exists, so
  // its decimals are real.
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
  // The treasuries' tokens are read only when a ticker is still open.
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

  return planLegacyImport(parsed, {
    ...tickers,
    wallet,
    aliases: ctx.aliases,
    workgroups: ctx.workgroups,
    setups: ctx.setups,
    existingKeys: ctx.existingKeys,
    hash: sha256,
    includeDuplicates: upload.includeDuplicates,
  });
}
