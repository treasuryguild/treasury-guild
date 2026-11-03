// Prefill the mint form from a previous mint row ("mint more" or "use as template").

import { joinChunks } from "@/lib/cardano/cip25";
import { TxState } from "@/lib/constants";
import type { MintWithTx } from "@/lib/db/types";
import {
  emptyImage,
  emptyNft,
  NEW_LOCK,
  type ImageState,
  type MintFormState,
  type MintReuseMode,
  type NftDraft,
} from "./types";

export type { MintReuseMode };

/** Keys written by buildCip25Entry that are not NFT traits. */
const CIP25_RESERVED = new Set([
  "name",
  "image",
  "mediaType",
  "description",
  "files",
  "ticker",
  "decimals",
  "url",
]);

export interface MintReuseActions {
  primary: MintReuseMode;
  /** Offered on mint-more-eligible FTs so the user can fork metadata. */
  secondary?: MintReuseMode;
}

/** Confirmed mint rows only; pending/rejected never offer reuse. */
export function isConfirmedMint(row: Pick<MintWithTx, "transaction">): boolean {
  return row.transaction?.state === TxState.Confirmed;
}

function policyStillMintable(
  row: Pick<MintWithTx, "lock_slot" | "lock_until">,
  nowMs: number,
): boolean {
  if (row.lock_slot === null) return true;
  if (!row.lock_until) return true;
  return Date.parse(row.lock_until) > nowMs;
}

/**
 * Which reuse buttons to show for a Minted assets row.
 * null = none (not confirmed).
 */
export function reuseActionsFor(
  row: Pick<MintWithTx, "asset_kind" | "lock_slot" | "lock_until" | "transaction">,
  nowMs: number,
): MintReuseActions | null {
  if (!isConfirmedMint(row)) return null;
  if (row.asset_kind === "nft") return { primary: "template" };
  if (policyStillMintable(row, nowMs)) {
    return { primary: "mint_more", secondary: "template" };
  }
  return { primary: "template" };
}

/** Primary mode only (tests / callers that do not need secondary). */
export function reuseModeFor(
  row: Pick<MintWithTx, "asset_kind" | "lock_slot" | "lock_until" | "transaction">,
  nowMs: number,
): MintReuseMode | null {
  return reuseActionsFor(row, nowMs)?.primary ?? null;
}

function metaString(meta: Record<string, unknown>, key: string): string {
  return joinChunks(meta[key]) ?? "";
}

function imageFromRow(row: Pick<MintWithTx, "image_cid" | "metadata">): ImageState {
  const meta = row.metadata ?? {};
  const mediaType =
    typeof meta.mediaType === "string" && meta.mediaType ? meta.mediaType : null;
  let cid = row.image_cid;
  if (!cid) {
    const image = joinChunks(meta.image);
    if (image?.startsWith("ipfs://")) cid = image.slice("ipfs://".length);
  }
  return {
    ...emptyImage(),
    cid,
    mediaType,
    fileName: cid ? "from-previous-mint" : null,
  };
}

function nftTraits(meta: Record<string, unknown>): { key: string; value: string }[] {
  const attrs: { key: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(meta)) {
    if (CIP25_RESERVED.has(key)) continue;
    const value = joinChunks(raw);
    if (!value) continue;
    attrs.push({ key, value });
  }
  if (attrs.length === 0) return [{ key: "", value: "" }];
  return attrs;
}

function policyPatch(
  row: Pick<MintWithTx, "lock_slot" | "lock_until">,
  nowMs: number,
): Pick<MintFormState, "policyMode" | "existingLock" | "lockUntil"> {
  if (row.lock_slot === null) {
    return { policyMode: "treasury", existingLock: NEW_LOCK, lockUntil: "" };
  }
  if (policyStillMintable(row, nowMs)) {
    return {
      policyMode: "locked",
      existingLock: String(row.lock_slot),
      lockUntil: "",
    };
  }
  // Expired lock: cannot continue that policy — start open.
  return { policyMode: "treasury", existingLock: NEW_LOCK, lockUntil: "" };
}

/**
 * Form fields taken from a previous mint. Supply is always cleared.
 * mint_more keeps the on-chain identity; template clears NFT names.
 */
export function mintFormFromRow(
  row: MintWithTx,
  mode: MintReuseMode,
  nowMs: number = Date.now(),
): Partial<MintFormState> {
  const meta = row.metadata ?? {};
  const policy = policyPatch(row, nowMs);
  const description = metaString(meta, "description");
  const url = metaString(meta, "url");
  const image = imageFromRow(row);

  if (row.asset_kind === "ft") {
    return {
      treasuryId: row.treasury_id,
      kind: "ft",
      ftName: row.asset_name,
      ticker: row.ticker ?? "",
      decimals: row.decimals,
      supply: "",
      ftDescription: description,
      url,
      ftImage: image,
      nfts: [emptyNft()],
      recipient: "",
      ...policy,
      reuse: {
        mode,
        sourceName: row.asset_name,
        sourceTicker: row.ticker,
      },
    };
  }

  const nft: NftDraft = {
    name: "",
    description,
    attributes: nftTraits(meta),
    image,
  };
  return {
    treasuryId: row.treasury_id,
    kind: "nft",
    ftName: "",
    ticker: "",
    decimals: 6,
    supply: "",
    ftDescription: "",
    url: "",
    ftImage: emptyImage(),
    nfts: [nft],
    recipient: "",
    ...policy,
    reuse: {
      mode: "template",
      sourceName: row.asset_name,
      sourceTicker: null,
    },
  };
}

export function reuseBannerText(
  reuse: NonNullable<MintFormState["reuse"]>,
  policyMode: MintFormState["policyMode"],
): string {
  const label = reuse.sourceTicker || reuse.sourceName;
  if (reuse.mode === "mint_more") {
    return policyMode === "locked"
      ? `Minting more of ${label} under the existing time-locked policy. Identity fields are locked; enter a new supply.`
      : `Minting more of ${label} under the open treasury policy. Identity fields are locked; enter a new supply.`;
  }
  return `Template from ${reuse.sourceName} — review the details and choose a name before building.`;
}
