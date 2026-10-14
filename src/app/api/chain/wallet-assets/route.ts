import { parseQuery, sessionRoute } from "@/lib/api/route";
import { addressQuerySchema } from "@/lib/api/schemas";
import type { WalletAssetsResponse } from "@/lib/api/types";
import { applyWalletTokenHint } from "@/lib/cardano/assetInfo";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { fetchWalletAssets } from "@/lib/cardano/walletAssets";
import { asNetwork } from "@/lib/config";
import { loadMintAssetHints } from "@/lib/db/assets";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const GET = sessionRoute(async (req, { session }) => {
  const { address } = parseQuery(req, addressQuerySchema);
  await enforceRateLimit("chainProxy", session.wallet);
  // The address prefix names the network; communities may be on either.
  const { lovelace, utxoCount, tokens } = await fetchWalletAssets(
    asNetwork(addressToNetwork(address)),
    address,
  );
  const unresolvedUnits = tokens
    .filter((token) => token.source === "ascii" || token.source === "none")
    .map((token) => token.unit);
  const mintHints = await loadMintAssetHints(unresolvedUnits);
  const resolvedTokens = tokens.map((token) =>
    applyWalletTokenHint(token, mintHints.get(token.unit)),
  );
  return {
    lovelace: lovelace.toString(),
    utxoCount,
    tokens: resolvedTokens.map((t) => ({
      unit: t.unit,
      quantity: t.quantity.toString(),
      ticker: t.ticker,
      name: t.name,
      decimals: t.decimals,
      source: t.source,
    })),
  } satisfies WalletAssetsResponse;
});
