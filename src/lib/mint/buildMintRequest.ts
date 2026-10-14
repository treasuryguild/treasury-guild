// Form state -> /api/tx/build-mint body.

import type { BuildMintBody, MintPolicyInput } from "@/lib/api/schemas";
import { NEW_LOCK, type MintFormState, type NftDraft } from "./types";

function policyInput(form: MintFormState): MintPolicyInput {
  if (form.policyMode === "treasury") return { mode: "treasury" };
  if (form.existingLock === NEW_LOCK) {
    return { mode: "locked", lockUntil: new Date(form.lockUntil).toISOString() };
  }
  return { mode: "locked", lockSlot: Number(form.existingLock) };
}

/** Trimmed, non-empty trait pairs as a record. */
export function nftAttributes(nft: NftDraft): Record<string, string> {
  return Object.fromEntries(
    nft.attributes
      .filter((a) => a.key.trim() && a.value.trim())
      .map((a) => [a.key.trim(), a.value.trim()]),
  );
}

export function buildMintRequest(form: MintFormState): BuildMintBody {
  const policy = policyInput(form);
  const recipient = form.recipient.trim() || undefined;
  if (form.kind === "ft") {
    return {
      treasuryId: form.treasuryId,
      assetKind: "ft",
      assets: [
        {
          name: form.ftName,
          description: form.ftDescription,
          imageCid: form.ftImage.cid ?? undefined,
          mediaType: form.ftImage.mediaType ?? undefined,
        },
      ],
      ticker: form.ticker,
      decimals: form.decimals,
      supply: form.supply.trim(),
      url: form.url,
      recipient,
      policy,
    };
  }
  return {
    treasuryId: form.treasuryId,
    assetKind: "nft",
    assets: form.nfts.map((n) => ({
      name: n.name,
      description: n.description,
      imageCid: n.image.cid ?? undefined,
      mediaType: n.image.mediaType ?? undefined,
      attributes: nftAttributes(n),
    })),
    recipient,
    policy,
  };
}
