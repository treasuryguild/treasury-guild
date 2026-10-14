// Auto-match GitHub bounty field names against the tickers of tokens actually
// held in the paying wallet. Pure and isomorphic: used by the Payday page
// (client) to drive the inline connect UI and by build-payout (server) to
// re-derive matches — the server never trusts client-side matching.

import { ADA_ASSET, resolveAsset, type AssetDef } from "./assets";

export interface MatchableToken {
  /** policyId(56 hex) + assetNameHex */
  unit: string;
  /** Ticker discovered from token metadata; null when unknown. */
  ticker: string | null;
  decimals: number;
}

export interface TokenMatchResult {
  /** Unambiguous ticker == field name matches (case-insensitive). */
  auto: AssetDef[];
  /** Field -> two or more wallet tokens sharing the ticker; user must pick. */
  ambiguous: Map<string, MatchableToken[]>;
  /** No wallet token matches; needs a manual connection. */
  unmatched: string[];
}

/**
 * Partition bounty field names into auto-matched / ambiguous / unmatched.
 * Fields already resolvable through the persisted registry (or the implicit
 * ADA asset) are excluded from every bucket — persisted mappings win.
 */
export function matchTokensToFields(
  fieldNames: string[],
  registry: AssetDef[],
  walletTokens: MatchableToken[],
): TokenMatchResult {
  const byTicker = new Map<string, MatchableToken[]>();
  for (const t of walletTokens) {
    if (!t.ticker) continue;
    const key = t.ticker.toLowerCase();
    const list = byTicker.get(key);
    if (list) list.push(t);
    else byTicker.set(key, [t]);
  }

  const auto: AssetDef[] = [];
  const ambiguous = new Map<string, MatchableToken[]>();
  const unmatched: string[] = [];
  const seen = new Set<string>();

  for (const field of fieldNames) {
    const lower = field.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    // ADA is built in and never matched against wallet tokens, even if a
    // token names its ticker "ADA".
    if (lower === ADA_ASSET.fieldName.toLowerCase()) continue;
    if (resolveAsset(registry, field)) continue;

    const candidates = byTicker.get(lower) ?? [];
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only) {
      auto.push({ fieldName: field, unit: only.unit, decimals: only.decimals });
    } else if (candidates.length > 1) {
      ambiguous.set(field, candidates);
    } else {
      unmatched.push(field);
    }
  }

  return { auto, ambiguous, unmatched };
}
