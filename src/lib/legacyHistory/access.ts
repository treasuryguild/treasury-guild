// Previous-wallet history is managed by community admins. Rows are loaded
// first so an id from another community is a 404, never a leak.
import "server-only";

import { requireAdmin } from "@/lib/authz";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { requireCommunity } from "@/lib/db/communities";
import {
  loadLegacyImport, loadLegacyPayment, loadLegacyReceipt, loadLegacyReceiptImport, loadLegacyWallet,
} from "@/lib/db/legacyHistory";
import type { LegacyImportRow, LegacyReceiptImportRow, LegacyWalletRow } from "@/lib/db/types";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { addressIsScript, resolveLegacyScriptClaim } from "./scriptClaim";

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

export async function requireLegacyReceiptImportAdmin(
  importId: string,
  wallet: string,
): Promise<LegacyReceiptImportRow> {
  const row = await loadLegacyReceiptImport(importId);
  if (!row) throw new NotFoundError("Receipt import not found");
  await requireAdmin(row.community_id, wallet);
  return row;
}

export async function requireLegacyReceiptAdmin(receiptId: string, wallet: string) {
  const row = await loadLegacyReceipt(receiptId);
  if (!row) throw new NotFoundError("Receipt line not found");
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

/** Script addresses need matching CBOR; key addresses must not carry script CBOR. */
export function resolveLegacyWalletScriptFields(
  address: string,
  scriptCbor?: string | null,
): { script_cbor: string | null; script_hash: string | null } {
  if (addressIsScript(address)) {
    if (!scriptCbor?.trim()) throw new BadRequestError("Paste the native script CBOR for this script address");
    const claim = resolveLegacyScriptClaim(address, scriptCbor);
    return { script_cbor: claim.scriptCbor, script_hash: claim.scriptHash };
  }
  if (scriptCbor?.trim()) throw new BadRequestError("Script CBOR belongs only on script addresses");
  return { script_cbor: null, script_hash: null };
}
