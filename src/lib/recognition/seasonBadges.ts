// Season badge NFT drafts for Exemplar wallets (Phase 7). Pure; the Mint page
// still builds and signs. Client-safe.

export interface SeasonBadgeDraft {
  /** Suggested on-chain asset name (≤32 bytes). */
  name: string;
  description: string;
  traits: Record<string, string>;
  recipientWallet: string;
}

/** Cap asset names to Cardano's 32-byte asset name limit (UTF-8). */
function assetName(seasonKey: string, index: number): string {
  const base = `Recog ${seasonKey} #${index + 1}`;
  const enc = new TextEncoder();
  if (enc.encode(base).length <= 32) return base;
  const short = `R${seasonKey.replace("-", "")}${index + 1}`;
  return short.slice(0, 32);
}

/**
 * One NFT draft per Exemplar (or Craft+) wallet for a season. Admins mint
 * these on the Mint page (treasury policy); this only suggests metadata.
 */
export function seasonBadgeDrafts(
  seasonKey: string,
  wallets: readonly string[],
  communityName: string,
): SeasonBadgeDraft[] {
  return wallets.map((recipientWallet, index) => ({
    name: assetName(seasonKey, index),
    description: `${communityName} recognition — ${seasonKey} Exemplar`,
    traits: {
      season: seasonKey,
      tier: "Exemplar",
      module: "recognition",
    },
    recipientWallet,
  }));
}
