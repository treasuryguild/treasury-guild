import { serializeNativeScript } from "@meshsdk/core";
import { parseJson, sessionRoute } from "@/lib/api/route";
import { previewTreasuryImportSchema } from "@/lib/api/schemas";
import type { TreasuryImportPreview } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { resolveRegistrationImport } from "@/lib/cardano/cip146Lookup";
import { addressToNetwork, checkValidAddress, paymentKeyHash } from "@/lib/cardano/multisigSDK";
import { slotTime } from "@/lib/cardano/slots";
import { decodeTreasuryCbor, type DecodedTreasuryScript } from "@/lib/cardano/treasuryImport";
import { asNetwork, type Network } from "@/lib/config";
import { SignerGroup } from "@/lib/constants";
import { requireCommunity } from "@/lib/db/communities";
import { communityMemberWallets } from "@/lib/db/membership";
import { InvariantError } from "@/lib/errors";

function previewFromDecoded(opts: {
  decoded: DecodedTreasuryScript;
  network: Network;
  stakeCredentialHash: string | null;
  suggestedName: string | null;
  participantNames: Record<string, { name: string }>;
  known: Map<string, string>;
  expectedAddress?: string;
}) {
  const { decoded, network, stakeCredentialHash, suggestedName, participantNames, known, expectedAddress } = opts;
  const { address } = serializeNativeScript(
    decoded.paymentScript,
    stakeCredentialHash ?? undefined,
    network,
    true,
  );
  if (expectedAddress && address !== expectedAddress) {
    throw new InvariantError("Discovered registration address does not match the reconstructed script");
  }
  const { shape } = decoded;
  const signer = (keyHash: string, group: SignerGroup) => ({
    keyHash,
    address: known.get(keyHash) ?? "",
    group,
    name: participantNames[keyHash.toLowerCase()]?.name ?? "",
  });
  return {
    address,
    scriptCbor: decoded.scriptCbor,
    stakeCredentialHash,
    suggestedName,
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
}

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, source } = await parseJson(req, previewTreasuryImportSchema);
  await requireAdmin(communityId, session.wallet);

  // CBOR: decode before the community read so bad hex fails without a DB round-trip.
  // CIP-0146: need the community network first to resolve on-chain.
  if (source.type === "cbor") {
    const decoded = decodeTreasuryCbor(source.cbor);
    const community = await requireCommunity(communityId);
    const network = asNetwork(community.network);
    const members = await communityMemberWallets(communityId);
    const known = new Map<string, string>();
    for (const address of [...members, session.wallet]) {
      if (checkValidAddress(address) && addressToNetwork(address) === network) {
        known.set(paymentKeyHash(address), address);
      }
    }
    return previewFromDecoded({
      decoded,
      network,
      stakeCredentialHash: source.stakeCredentialHash?.toLowerCase() ?? null,
      suggestedName: null,
      participantNames: {},
      known,
    });
  }

  const community = await requireCommunity(communityId);
  const network = asNetwork(community.network);
  const discovered = await resolveRegistrationImport(network, source.txHash);
  const members = await communityMemberWallets(communityId);
  const known = new Map<string, string>();
  for (const address of [...members, session.wallet]) {
    if (checkValidAddress(address) && addressToNetwork(address) === network) {
      known.set(paymentKeyHash(address), address);
    }
  }
  return previewFromDecoded({
    decoded: discovered.decoded,
    network,
    stakeCredentialHash: discovered.stakeCredentialHash,
    suggestedName: discovered.name || null,
    participantNames: discovered.participants,
    known,
    expectedAddress: discovered.address,
  });
});
