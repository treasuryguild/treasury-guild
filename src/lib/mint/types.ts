// Mint page form state. Client-safe.

export type MintKind = "ft" | "nft";
export type PolicyMode = "treasury" | "locked";

/** Sentinel for "create a new locked policy" in the existing-lock picker. */
export const NEW_LOCK = "new";

export interface ImageState {
  cid: string | null;
  mediaType: string | null;
  fileName: string | null;
  uploading: boolean;
  error: string | null;
}

export interface NftDraft {
  name: string;
  description: string;
  attributes: { key: string; value: string }[];
  image: ImageState;
}

export interface MintFormState {
  treasuryId: string;
  kind: MintKind;
  // fungible
  ftName: string;
  ticker: string;
  decimals: number;
  supply: string;
  ftDescription: string;
  url: string;
  ftImage: ImageState;
  // nft
  nfts: NftDraft[];
  // policy + recipient
  policyMode: PolicyMode;
  lockUntil: string;
  /** NEW_LOCK or a lock slot (as string) of a previously used policy. */
  existingLock: string;
  recipient: string;
}

export const emptyImage = (): ImageState => ({
  cid: null,
  mediaType: null,
  fileName: null,
  uploading: false,
  error: null,
});

export const emptyNft = (): NftDraft => ({
  name: "",
  description: "",
  attributes: [],
  image: emptyImage(),
});

export const emptyMintForm = (): MintFormState => ({
  treasuryId: "",
  kind: "ft",
  ftName: "",
  ticker: "",
  decimals: 6,
  supply: "",
  ftDescription: "",
  url: "",
  ftImage: emptyImage(),
  nfts: [emptyNft()],
  policyMode: "treasury",
  lockUntil: "",
  existingLock: NEW_LOCK,
  recipient: "",
});

export interface LockedPolicy {
  policyId: string;
  lockSlot: number;
  lockUntil: string | null;
}
