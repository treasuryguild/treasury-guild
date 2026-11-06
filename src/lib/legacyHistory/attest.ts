// Verify ownership signatures for a staged previous-wallet import and activate
// when the key address or script base threshold is met.
import "server-only";

import { paymentKeyHash } from "@/lib/cardano/multisigSDK";
import { verifyWalletSignature } from "@/lib/auth/walletSignature";
import {
  activateLegacyHistory, activateLegacyReceipts, insertLegacyImportSignature,
  loadLegacyImport, loadLegacyImportSignatures, loadLegacyReceiptImport, loadLegacyWallet,
} from "@/lib/db/legacyHistory";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { appUrl } from "@/lib/env.server";
import { legacyAttestationText, type LegacyAttestKind } from "./attestation";
import { resolveLegacyScriptClaim } from "./scriptClaim";

function hostOfApp(): string {
  try {
    return new URL(appUrl()).host;
  } catch {
    return "localhost";
  }
}

export interface AttestImportArgs {
  kind: LegacyAttestKind;
  importId: string;
  communitySlug: string;
  signedAt: string;
  key: string;
  signature: string;
  signerAddress: string;
  actor: string;
}

export interface AttestImportResult {
  importId: string;
  state: "pending_signatures" | "active";
  signatures: number;
  required: number;
  inserted?: number;
}

export async function attestLegacyImport(args: AttestImportArgs): Promise<AttestImportResult> {
  const imp = args.kind === "payments"
    ? await loadLegacyImport(args.importId)
    : await loadLegacyReceiptImport(args.importId);
  if (!imp) throw new NotFoundError("Import not found");
  if (imp.state !== "pending_signatures" || !imp.plan_hash) {
    throw new BadRequestError("This import is not awaiting signatures");
  }

  const wallet = await loadLegacyWallet(imp.legacy_wallet_id);
  if (!wallet) throw new NotFoundError("Previous wallet not found");

  const text = legacyAttestationText({
    host: hostOfApp(),
    community: args.communitySlug,
    legacyWalletId: wallet.id,
    address: wallet.address,
    kind: args.kind,
    planHash: imp.plan_hash,
    signedAt: args.signedAt,
  });

  const ok = await verifyWalletSignature(text, { key: args.key, signature: args.signature }, args.signerAddress);
  if (!ok) throw new BadRequestError("Signature does not match this import");

  let keyHash: string;
  try {
    keyHash = paymentKeyHash(args.signerAddress).toLowerCase();
  } catch {
    throw new BadRequestError("Signer must be a payment-key address");
  }

  let required = 1;
  let allowed: Set<string>;

  if (wallet.script_cbor) {
    const claim = resolveLegacyScriptClaim(wallet.address, wallet.script_cbor);
    required = claim.required;
    allowed = new Set(claim.baseKeyHashes);
  } else {
    try {
      allowed = new Set([paymentKeyHash(wallet.address).toLowerCase()]);
    } catch {
      throw new BadRequestError("Previous wallet address is a script; paste its CBOR first");
    }
  }

  if (!allowed.has(keyHash)) {
    throw new ForbiddenError("This key is not a base signer of the previous wallet");
  }

  await insertLegacyImportSignature({
    kind: args.kind,
    import_id: imp.id,
    signer_address: args.signerAddress,
    key_hash: keyHash,
    cose_key: args.key,
    signature: args.signature,
    signed_at: args.signedAt,
  });

  const signatures = await loadLegacyImportSignatures(args.kind, imp.id);
  const count = new Set(signatures.map((s) => s.key_hash)).size;
  if (count < required) {
    return { importId: imp.id, state: "pending_signatures", signatures: count, required };
  }

  const activated = args.kind === "payments"
    ? await activateLegacyHistory(imp.id, args.actor)
    : await activateLegacyReceipts(imp.id, args.actor);

  return {
    importId: imp.id,
    state: "active",
    signatures: count,
    required,
    inserted: activated.inserted,
  };
}
