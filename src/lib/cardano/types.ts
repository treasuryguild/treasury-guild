// Client-safe Cardano domain types (no WASM imports).

/** Native-script threshold shape of a multisig treasury. */
export type ScriptType = "all" | "any" | "atLeast";

/** A native script read back from CBOR (decoded server-side, matched by `templates.ts`). */
export type DecodedNativeScript =
  | { type: "sig"; keyHash: string }
  | { type: "all"; scripts: DecodedNativeScript[] }
  | { type: "any"; scripts: DecodedNativeScript[] }
  | { type: "atLeast"; required: number; scripts: DecodedNativeScript[] }
  | { type: "timelockStart"; slot: string }
  | { type: "timelockExpiry"; slot: string };

export interface DecodedTxOutput {
  address: string;
  lovelace: string;
  /** Native tokens: unit = policyIdHex + assetNameHex. */
  assets: { unit: string; quantity: string }[];
}

export interface DecodedTxMint {
  /** policyIdHex + assetNameHex */
  unit: string;
  policyId: string;
  assetNameHex: string;
  /** Signed: negative = burn. */
  quantity: string;
}

/** Everything the signing page shows, decoded from the tx CBOR. */
export interface DecodedTxView {
  outputs: DecodedTxOutput[];
  fee: string | null;
  message: string | null;
  payoutMeta: unknown;
  /** The label-190002 anchor record, if present. */
  anchorMeta: unknown;
  mint: DecodedTxMint[];
  cip25Meta: unknown;
  ttl: string | null;
}

export const EMPTY_TX_VIEW: DecodedTxView = {
  outputs: [],
  fee: null,
  message: null,
  payoutMeta: null,
  anchorMeta: null,
  mint: [],
  cip25Meta: null,
  ttl: null,
};
