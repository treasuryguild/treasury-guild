// Add a wallet the community paid from before Guild Vault. Its address is a
// label only: nothing ever reads that wallet on-chain.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { createLegacyWalletSchema } from "@/lib/api/schemas";
import type { LegacyWalletCreatedResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { requireLegacyAddressNetwork } from "@/lib/legacyHistory/access";
import { createLegacyWallet } from "@/lib/db/legacyHistory";

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, name, address } = await parseJson(req, createLegacyWalletSchema);
  await requireAdmin(communityId, session.wallet);
  if (address) await requireLegacyAddressNetwork(communityId, address);
  const wallet = await createLegacyWallet({
    community_id: communityId,
    name: name.trim(),
    address: address ?? null,
    created_by: session.wallet,
  });
  return { id: wallet.id } satisfies LegacyWalletCreatedResponse;
});
