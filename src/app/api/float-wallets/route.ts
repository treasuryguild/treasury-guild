// Create a watched float wallet for DEX / dApp floats (migration 0088).
import { parseJson, sessionRoute } from "@/lib/api/route";
import { createFloatWalletSchema } from "@/lib/api/schemas";
import type { FloatWalletCreatedResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { requireCommunity } from "@/lib/db/communities";
import { createFloatWallet, tagFloatTransfers } from "@/lib/db/floatWallets";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { BadRequestError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, name, address, note } = await parseJson(req, createFloatWalletSchema);
  await requireAdmin(communityId, session.wallet);
  await enforceRateLimit("floatWalletCreate", session.wallet);

  const community = await requireCommunity(communityId);
  if (addressToNetwork(address) !== community.network) {
    throw new BadRequestError(
      community.network === 1 ? "Use a mainnet address (addr1…)" : "Use a preprod address (addr_test1…)",
    );
  }

  const wallet = await createFloatWallet({
    community_id: communityId,
    name: name.trim(),
    address,
    note: note?.trim() || null,
    created_by: session.wallet,
  });
  // Tag any already-polled treasury rows that already name this address.
  await tagFloatTransfers(communityId);
  return { id: wallet.id } satisfies FloatWalletCreatedResponse;
});
