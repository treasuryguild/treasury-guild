// Funding sources are managed by community admins. Rows are loaded first so
// an id from another community is a 404; planned amounts get their ticker and
// decimals from ADA, the token registry or the chain, never from the browser.
import "server-only";

import { ADA_ASSET } from "@/lib/assets";
import { requireAdmin } from "@/lib/authz";
import { describeKnownTokens } from "@/lib/cardano/walletAssets";
import { asNetwork } from "@/lib/config";
import { loadAssetRegistry } from "@/lib/db/assets";
import { requireCommunity } from "@/lib/db/communities";
import { loadFundingCommitment, loadFundingSource } from "@/lib/db/funding";
import type { FundingCommitmentRow, FundingSourceRow } from "@/lib/db/types";
import { BadRequestError, errorMessage, NotFoundError, UpstreamError } from "@/lib/errors";
import type { FundingToken } from "./amounts";

export async function requireFundingSourceAdmin(sourceId: string, wallet: string): Promise<FundingSourceRow> {
  const source = await loadFundingSource(sourceId);
  if (!source) throw new NotFoundError("Funding source not found");
  await requireAdmin(source.community_id, wallet);
  return source;
}

export async function requireFundingCommitmentAdmin(commitmentId: string, wallet: string): Promise<FundingCommitmentRow> {
  const commitment = await loadFundingCommitment(commitmentId);
  if (!commitment) throw new NotFoundError("Commitment not found");
  await requireAdmin(commitment.community_id, wallet);
  return commitment;
}

/**
 * Ticker and decimals of each unit: ADA, then the community's token
 * registry, then a unit the chain knows (Koios), so a planned amount is
 * always scaled with the token's real decimals.
 */
export async function resolveFundingTokens(communityId: string, units: readonly string[]): Promise<Map<string, FundingToken>> {
  const tokens = new Map<string, FundingToken>();
  const wanted = [...new Set(units)];
  if (wanted.includes(ADA_ASSET.unit)) tokens.set(ADA_ASSET.unit, { ticker: ADA_ASSET.fieldName, decimals: ADA_ASSET.decimals });
  const rest = wanted.filter((unit) => !tokens.has(unit));
  if (rest.length === 0) return tokens;
  for (const asset of await loadAssetRegistry(communityId)) {
    if (rest.includes(asset.unit)) tokens.set(asset.unit, { ticker: asset.fieldName, decimals: asset.decimals });
  }
  const unknown = rest.filter((unit) => !tokens.has(unit));
  if (unknown.length === 0) return tokens;
  const community = await requireCommunity(communityId);
  let described;
  try {
    described = await describeKnownTokens(asNetwork(community.network), unknown);
  } catch (err) {
    throw new UpstreamError(`Could not look up the tokens: ${errorMessage(err, "chain provider error")}`);
  }
  for (const unit of unknown) {
    const token = described.get(unit);
    if (!token) throw new BadRequestError(`No token with the unit ${unit.slice(0, 12)}… exists on this network`);
    tokens.set(unit, { ticker: (token.ticker ?? token.name ?? unit.slice(-8)).slice(0, 32), decimals: token.decimals });
  }
  return tokens;
}
