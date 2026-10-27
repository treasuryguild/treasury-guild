import { parseJson, sessionRoute } from "@/lib/api/route";
import { createCommunitySchema, patchCommunitySchema } from "@/lib/api/schemas";
import type { CreateCommunityResponse, OkResponse } from "@/lib/api/types";
import { LOVELACE } from "@/lib/assets";
import { requireAdmin } from "@/lib/authz";
import { fetchWalletAssets } from "@/lib/cardano/walletAssets";
import { asNetwork } from "@/lib/config";
import { loadAssetRegistry } from "@/lib/db/assets";
import { loadCommunityTreasuries } from "@/lib/db/treasuries";
import { createCommunity, updateCommunity } from "@/lib/db/communities";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { BadRequestError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const { slug, name, description, network, visibility } = await parseJson(
    req,
    createCommunitySchema,
  );
  await enforceRateLimit("communityCreate", session.wallet);

  const community = await createCommunity({
    slug,
    name,
    description: description || null,
    network,
    visibility,
    createdBy: session.wallet,
  });
  return { community } satisfies CreateCommunityResponse;
});

/**
 * A non-ADA main spending token must be one the community has paid out
 * (registry) or one a treasury wallet currently holds — the same sources the
 * budgets route accepts, across every treasury since the setting is
 * community-wide. Each wallet is read on its own network.
 */
async function assertCommunityToken(communityId: string, unit: string): Promise<void> {
  if (unit === LOVELACE) return;
  const registry = await loadAssetRegistry(communityId);
  if (registry.some((asset) => asset.unit === unit)) return;

  const treasuries = await loadCommunityTreasuries(communityId);
  const wallets = await Promise.allSettled(
    treasuries.map((treasury) => fetchWalletAssets(asNetwork(treasury.network), treasury.address)),
  );
  const held = wallets.some((result) =>
    result.status === "fulfilled" && result.value.tokens.some((token) => token.unit === unit));
  if (!held) {
    throw new BadRequestError(
      "The main spending token must be one the community has paid out or a treasury wallet currently holds",
    );
  }
}

// Community settings (visibility, main spending token, Discord exchange
// rate). Communities have no client write policy — deliberate; all community
// mutations authorize in code with the service role.
export const PATCH = sessionRoute(async (req, { session }) => {
  const { communityId, visibility, spendingUnit, discordRateCoin, discordRateCurrency } = await parseJson(
    req,
    patchCommunitySchema,
  );
  await requireAdmin(communityId, session.wallet);

  const patch: Record<string, unknown> = {};
  if (visibility !== undefined) patch.visibility = visibility;
  if (spendingUnit !== undefined) {
    await assertCommunityToken(communityId, spendingUnit);
    patch.spending_unit = spendingUnit;
  }
  if (discordRateCoin !== undefined) patch.discord_rate_coin = discordRateCoin;
  if (discordRateCurrency !== undefined) patch.discord_rate_currency = discordRateCurrency;

  await updateCommunity(communityId, patch);
  return { ok: true } satisfies OkResponse;
});
