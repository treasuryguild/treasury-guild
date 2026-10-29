// Look up on-chain CIP-0146 (label 1854) registrations that list any of the
// given participant key hashes. Used by the treasury details registration
// card and the import Discover tab.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { cip146LookupQuerySchema } from "@/lib/api/schemas";
import type { Cip146LookupResponse } from "@/lib/api/types";
import { joinMetadataString } from "@/lib/cardano/cip146Registration";
import { lookupRegistrations } from "@/lib/cardano/cip146Lookup";
import { asNetwork } from "@/lib/config";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const GET = sessionRoute(async (req, { session }) => {
  const { network, pubKeyHashes } = parseQuery(req, cip146LookupQuerySchema);
  await enforceRateLimit("chainProxy", session.wallet);
  const items = await lookupRegistrations(asNetwork(network), pubKeyHashes);
  return {
    registrations: items.map((item) => ({
      txHash: item.tx_hash.toLowerCase(),
      name: joinMetadataString(item.json_metadata?.name),
      description: joinMetadataString(item.json_metadata?.description),
      types: item.json_metadata?.types ?? [],
      participants: item.json_metadata?.participants ?? {},
    })),
  } satisfies Cip146LookupResponse;
});
