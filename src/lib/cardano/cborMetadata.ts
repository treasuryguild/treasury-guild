// Read metadata and outputs back from a transaction's CBOR.
//
// Metadata can NOT be read from any stored builder JSON: MeshTxBuilder keeps
// metadata in a Map, which JSON.stringify renders as {} — the CBOR is the only
// faithful source. core-csl is safe here because this is read-only analysis
// (nothing is re-encoded or persisted).
import "server-only";

import { ANCHOR_METADATA_LABEL } from "./anchorMetadata";
import { joinChunks } from "./cip25";
import { METADATA_LABEL_1854 } from "./cip146Registration";
import { csl } from "./csl";
import { CIP20_LABEL, PAYOUT_METADATA_LABEL } from "./metadata";
import { CIP25_LABEL } from "./mintMetadata";
import {
  EMPTY_TX_VIEW,
  type DecodedTxMint,
  type DecodedTxOutput,
  type DecodedTxView,
} from "./types";
import { joinUnit } from "./units";

/** One-shot decode for the signing page; undecodable CBOR yields the empty view. */
export function decodeTxForDisplay(txCbor: string): DecodedTxView {
  try {
    return {
      outputs: decodeTxOutputs(txCbor),
      fee: decodeTxFee(txCbor) ?? null,
      message: extractTxMessage(txCbor) ?? null,
      payoutMeta: extractPayoutMetadata(txCbor) ?? null,
      anchorMeta: extractAnchorMetadata(txCbor) ?? null,
      registrationMeta: extractRegistrationMetadata(txCbor) ?? null,
      mint: decodeTxMint(txCbor),
      cip25Meta: extractCip25Metadata(txCbor) ?? null,
      ttl: decodeTxTtl(txCbor) ?? null,
    };
  } catch {
    return EMPTY_TX_VIEW;
  }
}

function decodeLabel(txCbor: string, label: string): unknown {
  try {
    const metadata = csl.Transaction.from_hex(txCbor)
      .auxiliary_data()
      ?.metadata();
    const metadatum = metadata?.get(csl.BigNum.from_str(label));
    if (!metadatum) return undefined;
    return JSON.parse(
      csl.decode_metadatum_to_json_str(
        metadatum,
        csl.MetadataJsonSchema.BasicConversions,
      ),
    );
  } catch {
    return undefined;
  }
}

/** CIP-20 (674) message, chunks joined. */
export function extractTxMessage(txCbor: string): string | undefined {
  const decoded = decodeLabel(txCbor, CIP20_LABEL) as { msg?: unknown } | undefined;
  return joinChunks(decoded?.msg) ?? undefined;
}

/** The label-190001 payout metadata object, if present. */
export function extractPayoutMetadata(txCbor: string): unknown {
  return decodeLabel(txCbor, PAYOUT_METADATA_LABEL);
}

/** The label-190002 anchor record, if present. */
export function extractAnchorMetadata(txCbor: string): unknown {
  return decodeLabel(txCbor, ANCHOR_METADATA_LABEL);
}

/** The label-1854 CIP-0146 registration record, if present. */
export function extractRegistrationMetadata(txCbor: string): unknown {
  return decodeLabel(txCbor, METADATA_LABEL_1854);
}

/** Decode the tx body's outputs (incl. native tokens) for the signing page.
 * Signers must see the full value being sent, not just the ADA. */
export function decodeTxOutputs(txCbor: string): DecodedTxOutput[] {
  const outputs = csl.Transaction.from_hex(txCbor).body().outputs();
  const out: DecodedTxOutput[] = [];
  for (let i = 0; i < outputs.len(); i++) {
    const o = outputs.get(i);
    const assets: { unit: string; quantity: string }[] = [];
    const multiasset = o.amount().multiasset();
    if (multiasset) {
      const policies = multiasset.keys();
      for (let p = 0; p < policies.len(); p++) {
        const policy = policies.get(p);
        const names = multiasset.get(policy);
        if (!names) continue;
        const nameKeys = names.keys();
        for (let n = 0; n < nameKeys.len(); n++) {
          const name = nameKeys.get(n);
          const quantity = names.get(name);
          if (!quantity) continue;
          assets.push({
            unit: joinUnit(
              policy.to_hex(),
              Buffer.from(name.name()).toString("hex"),
            ),
            quantity: quantity.to_str(),
          });
        }
      }
    }
    out.push({
      address: o.address().to_bech32(),
      lovelace: o.amount().coin().to_str(),
      assets,
    });
  }
  return out;
}

/** The label-721 (CIP-25) metadata object, if present. */
export function extractCip25Metadata(txCbor: string): unknown {
  return decodeLabel(txCbor, CIP25_LABEL);
}

/** Decode the tx body's mint field so signers see exactly what is forged. */
export function decodeTxMint(txCbor: string): DecodedTxMint[] {
  const mint = csl.Transaction.from_hex(txCbor).body().mint();
  if (!mint) return [];
  const out: DecodedTxMint[] = [];
  const policies = mint.keys();
  for (let p = 0; p < policies.len(); p++) {
    const policy = policies.get(p);
    const policyId = policy.to_hex();
    const groups = mint.get(policy);
    if (!groups) continue;
    for (let g = 0; g < groups.len(); g++) {
      const assets = groups.get(g);
      if (!assets) continue;
      const names = assets.keys();
      for (let n = 0; n < names.len(); n++) {
        const name = names.get(n);
        const quantity = assets.get(name);
        if (!quantity) continue;
        const assetNameHex = Buffer.from(name.name()).toString("hex");
        out.push({
          unit: joinUnit(policyId, assetNameHex),
          policyId,
          assetNameHex,
          quantity: quantity.to_str(),
        });
      }
    }
  }
  return out;
}

/** The tx body's TTL (invalid_hereafter slot), if set. */
export function decodeTxTtl(txCbor: string): string | undefined {
  try {
    return csl.Transaction.from_hex(txCbor).body().ttl_bignum()?.to_str();
  } catch {
    return undefined;
  }
}

/** Bech32 addresses of the tx body's inputs' spenders are unknown from CBOR;
 * expose the fee for display instead. */
export function decodeTxFee(txCbor: string): string | undefined {
  try {
    return csl.Transaction.from_hex(txCbor).body().fee().to_str();
  } catch {
    return undefined;
  }
}
