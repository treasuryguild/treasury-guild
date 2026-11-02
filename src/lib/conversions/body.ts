// Map API conversion bodies onto db insert shapes.
import type { ConversionFeeInput, ConversionProofInput } from "@/lib/db/conversions";
import type { ConversionChain, ConversionFeeKind } from "@/lib/db/types";

export function conversionFeeRows(
  fees: readonly { kind: ConversionFeeKind; amount: string; assetLabel: string; chain?: ConversionChain | null }[],
): ConversionFeeInput[] {
  return fees.map((f) => ({
    kind: f.kind,
    amount: f.amount,
    asset_label: f.assetLabel,
    chain: f.chain ?? null,
  }));
}

export function conversionProofRows(
  proofs: readonly { chain: ConversionChain; txHash: string; url?: string | null; label?: string | null }[],
): ConversionProofInput[] {
  return proofs.map((p) => ({
    chain: p.chain,
    tx_hash: p.txHash,
    url: p.url ?? null,
    label: p.label ?? null,
  }));
}
