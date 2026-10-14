// Previous-wallet history is managed by community admins. Rows are loaded
// first so an id from another community is a 404, never a leak.
import "server-only";

import { requireAdmin } from "@/lib/authz";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { requireCommunity } from "@/lib/db/communities";
import { loadLegacyImport, loadLegacyPayment, loadLegacyWallet } from "@/lib/db/legacyHistory";
import type { LegacyImportRow, LegacyWalletRow } from "@/lib/db/types";
import { BadRequestError, NotFoundError } from "@/lib/errors";

export async function requireLegacyWalletAdmin(walletId: string, wallet: string): Promise<LegacyWalletRow> {
  const row = await loadLegacyWallet(walletId);
  if (!row) throw new NotFoundError("Previous wallet not found");
  await requireAdmin(row.community_id, wallet);
  return row;
}

export async function requireLegacyImportAdmin(importId: string, wallet: string): Promise<LegacyImportRow> {
  const row = await loadLegacyImport(importId);
  if (!row) throw new NotFoundError("Import not found");
  await requireAdmin(row.community_id, wallet);
  return row;
}

export async function requireLegacyPaymentAdmin(paymentId: string, wallet: string) {
  const row = await loadLegacyPayment(paymentId);
  if (!row) throw new NotFoundError("History line not found");
  await requireAdmin(row.community_id, wallet);
  return row;
}

/** A label, but on the community's network so it cannot be mistaken for another chain's wallet. */
export async function requireLegacyAddressNetwork(communityId: string, address: string): Promise<void> {
  const community = await requireCommunity(communityId);
  if (addressToNetwork(address) !== community.network) {
    throw new BadRequestError(
      community.network === 1 ? "Use a mainnet address (addr1…)" : "Use a preprod address (addr_test1…)",
    );
  }
}
