// Client-side validation of the mint form (the route re-validates).

import { validateAssetName, validateTicker } from "@/lib/cardano/mintMetadata";
import { MIN_LOCK_LEAD_MS } from "@/lib/constants";
import { NEW_LOCK, type MintFormState } from "./types";

const SUPPLY_RE = /^\d+(\.\d+)?$/;

export function validateMintForm(
  form: MintFormState,
  ctx: { canMintHere: boolean; now: number },
): string | null {
  if (!form.treasuryId) return "Choose a treasury";
  if (!ctx.canMintHere) return "Only signers of this treasury can mint";

  if (form.kind === "ft") {
    const n = validateAssetName(form.ftName);
    if (!n.ok) return n.error;
    const t = validateTicker(form.ticker);
    if (!t.ok) return t.error;
    const supply = form.supply.trim();
    if (!SUPPLY_RE.test(supply) || Number(supply) <= 0) {
      return "Enter the total supply";
    }
    if (!form.ftImage.cid) return "Upload a logo image";
  } else {
    if (form.nfts.length === 0) return "Add at least one NFT";
    const names = new Set<string>();
    for (const [i, n] of form.nfts.entries()) {
      const v = validateAssetName(n.name);
      if (!v.ok) return `NFT #${i + 1}: ${v.error}`;
      if (names.has(v.name)) return `NFT #${i + 1}: duplicate name`;
      names.add(v.name);
      if (!n.image.cid) return `NFT #${i + 1}: upload an image`;
    }
  }

  if (form.policyMode === "locked" && form.existingLock === NEW_LOCK) {
    if (!form.lockUntil) return "Choose when the policy locks";
    if (Date.parse(form.lockUntil) < ctx.now + MIN_LOCK_LEAD_MS) {
      return "The policy lock must be at least one hour in the future";
    }
  }
  return null;
}
