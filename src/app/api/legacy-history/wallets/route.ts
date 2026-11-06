// Add a wallet the community paid from before Treasury Guild. Its address is
// required; chain verification matches CSV lines to that wallet's on-chain txs.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { createLegacyWalletSchema } from "@/lib/api/schemas";
import type { LegacyWalletCreatedResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { requireLegacyAddressNetwork, resolveLegacyWalletScriptFields } from "@/lib/legacyHistory/access";
import { createLegacyWallet } from "@/lib/db/legacyHistory";

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, name, address, scriptCbor } = await parseJson(req, createLegacyWalletSchema);
  await requireAdmin(communityId, session.wallet);
  await requireLegacyAddressNetwork(communityId, address);
  const script = resolveLegacyWalletScriptFields(address, scriptCbor);
  const wallet = await createLegacyWallet({
    community_id: communityId,
    name: name.trim(),
    address,
    ...script,
    created_by: session.wallet,
  });
  return { id: wallet.id } satisfies LegacyWalletCreatedResponse;
});
