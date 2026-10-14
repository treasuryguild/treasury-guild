import { parseQuery, sessionRoute } from "@/lib/api/route";
import { addressQuerySchema } from "@/lib/api/schemas";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { getProvider } from "@/lib/cardano/provider";
import { asNetwork } from "@/lib/config";
import { enforceRateLimit } from "@/lib/db/rateLimit";

// Communities run on either network, so the address prefix picks the Koios
// host rather than a deployment-wide setting.
export const GET = sessionRoute(async (req, { session }) => {
  const { address } = parseQuery(req, addressQuerySchema);
  await enforceRateLimit("chainProxy", session.wallet);
  const utxos = await getProvider(asNetwork(addressToNetwork(address))).fetchAddressUTxOs(address);
  return { utxos };
});
