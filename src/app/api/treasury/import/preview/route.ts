import { serializeNativeScript } from "@meshsdk/core";
import { parseJson, sessionRoute } from "@/lib/api/route";
import { previewTreasuryImportSchema } from "@/lib/api/schemas";
import type { TreasuryImportPreview } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { addressToNetwork, checkValidAddress, paymentKeyHash } from "@/lib/cardano/multisigSDK";
import { slotTime } from "@/lib/cardano/slots";
import { decodeTreasuryCbor } from "@/lib/cardano/treasuryImport";
import { asNetwork } from "@/lib/config";
import { SignerGroup } from "@/lib/constants";
import { requireCommunity } from "@/lib/db/communities";
import { communityMemberWallets } from "@/lib/db/membership";

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, source } = await parseJson(req, previewTreasuryImportSchema);
  await requireAdmin(communityId, session.wallet);
  const decoded = decodeTreasuryCbor(source.cbor);
  const community = await requireCommunity(communityId);
  const network = asNetwork(community.network);
  const members = await communityMemberWallets(communityId);
  const known = new Map<string, string>();
  // Prefer the active session's address when several addresses share a key.
  for (const address of [...members, session.wallet]) {
    if (checkValidAddress(address) && addressToNetwork(address) === network) {
      known.set(paymentKeyHash(address), address);
    }
  }
  const { address } = serializeNativeScript(decoded.paymentScript, undefined, network, true);
  const { shape } = decoded;
  const signer = (keyHash: string, group: SignerGroup) => ({ keyHash, address: known.get(keyHash) ?? "", group });
  return {
    address,
    scriptCbor: decoded.scriptCbor,
    template: shape.template,
    scriptType: shape.base.scriptType,
    required: shape.base.required,
    recovery: shape.recovery ? { scriptType: shape.recovery.scriptType, required: shape.recovery.required } : null,
    lockSlot: shape.lockSlot,
    lockUntil: shape.lockSlot === null ? null : slotTime(network, shape.lockSlot),
    signers: [
      ...shape.base.keyHashes.map((k) => signer(k, SignerGroup.Base)),
      ...(shape.recovery?.keyHashes ?? []).map((k) => signer(k, SignerGroup.Recovery)),
      ...(shape.cosignerKeyHash ? [signer(shape.cosignerKeyHash, SignerGroup.Cosigner)] : []),
    ],
  } satisfies TreasuryImportPreview;
});
