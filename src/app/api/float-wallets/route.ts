// Create a watched float wallet for DEX / dApp floats (migration 0088).
import { parseJson, sessionRoute } from "@/lib/api/route";
import { createFloatWalletSchema } from "@/lib/api/schemas";
import type { FloatWalletCreatedResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { txInfoBulk } from "@/lib/cardano/koios";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { asNetwork } from "@/lib/config";
import { requireCommunity } from "@/lib/db/communities";
import { classifyPoolRewardInflows, createFloatWallet, tagFloatTransfers } from "@/lib/db/floatWallets";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { BadRequestError } from "@/lib/errors";
import { txTouchesAddress } from "@/lib/float/syncFrom";

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, name, address, note, purpose, afterTxHash } = await parseJson(req, createFloatWalletSchema);
  await requireAdmin(communityId, session.wallet);
  await enforceRateLimit("floatWalletCreate", session.wallet);

  const community = await requireCommunity(communityId);
  if (addressToNetwork(address) !== community.network) {
    throw new BadRequestError(
      community.network === 1 ? "Use a mainnet address (addr1…)" : "Use a preprod address (addr_test1…)",
    );
  }

  let syncFromTx: string | null = null;
  let syncFromBlock: number | null = null;
  if (afterTxHash) {
    const hash = afterTxHash.toLowerCase();
    const [info] = await txInfoBulk(asNetwork(community.network), [hash]);
    if (!info) throw new BadRequestError("That transaction was not found on this network");
    if (!txTouchesAddress(info, address)) {
      throw new BadRequestError("That transaction does not involve this float address");
    }
    syncFromTx = hash;
    syncFromBlock = info.block_height;
  }

  const wallet = await createFloatWallet({
    community_id: communityId,
    name: name.trim(),
    address,
    note: note?.trim() || null,
    purpose: purpose ?? "dex",
    created_by: session.wallet,
    sync_from_tx_hash: syncFromTx,
    sync_from_block: syncFromBlock,
  });
  // Tag any already-polled treasury rows that already name this address.
  await tagFloatTransfers(communityId);
  await classifyPoolRewardInflows(communityId);
  return { id: wallet.id } satisfies FloatWalletCreatedResponse;
});
