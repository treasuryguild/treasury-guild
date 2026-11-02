"use client";

import { browserClient } from "@/lib/supabase/browser";
import {
  INCOMING_CONVERSION_COLUMNS,
  INCOMING_CONVERSION_FEE_COLUMNS,
  INCOMING_CONVERSION_PROOF_COLUMNS,
  type IncomingConversionFeeRow,
  type IncomingConversionProofRow,
  type IncomingConversionRow,
} from "@/lib/db/types";
import type { ConversionView } from "@/components/reconcile/ConversionForm";
import { useAsyncData, type AsyncData } from "./useAsyncData";

async function loadParts(ids: string[]): Promise<{
  fees: IncomingConversionFeeRow[];
  proofs: IncomingConversionProofRow[];
}> {
  if (ids.length === 0) return { fees: [], proofs: [] };
  const db = browserClient();
  const [fees, proofs] = await Promise.all([
    db.from("incoming_conversion_fees").select(INCOMING_CONVERSION_FEE_COLUMNS).in("conversion_id", ids).order("position"),
    db.from("incoming_conversion_proofs").select(INCOMING_CONVERSION_PROOF_COLUMNS).in("conversion_id", ids).order("position"),
  ]);
  if (fees.error) throw new Error(fees.error.message);
  if (proofs.error) throw new Error(proofs.error.message);
  return {
    fees: (fees.data ?? []) as IncomingConversionFeeRow[],
    proofs: (proofs.data ?? []) as IncomingConversionProofRow[],
  };
}

function assemble(
  conversions: IncomingConversionRow[],
  fees: IncomingConversionFeeRow[],
  proofs: IncomingConversionProofRow[],
): ConversionView[] {
  const feesBy = new Map<string, IncomingConversionFeeRow[]>();
  for (const fee of fees) {
    const list = feesBy.get(fee.conversion_id) ?? [];
    list.push(fee);
    feesBy.set(fee.conversion_id, list);
  }
  const proofsBy = new Map<string, IncomingConversionProofRow[]>();
  for (const proof of proofs) {
    const list = proofsBy.get(proof.conversion_id) ?? [];
    list.push(proof);
    proofsBy.set(proof.conversion_id, list);
  }
  return conversions.map((c) => ({
    ...c,
    fees: feesBy.get(c.id) ?? [],
    proofs: proofsBy.get(c.id) ?? [],
  }));
}

/** Conversions for the listed treasury and/or float inflow hashes (RLS). */
export function useConversionsForInflows(
  incomingTxHashes: readonly string[],
  floatIncomingTxHashes: readonly string[] = [],
): AsyncData<ConversionView[]> {
  const key = [
    incomingTxHashes.length ? `t:${incomingTxHashes.join(",")}` : "",
    floatIncomingTxHashes.length ? `f:${floatIncomingTxHashes.join(",")}` : "",
  ].filter(Boolean).join("|") || null;

  return useAsyncData(key, async () => {
    const db = browserClient();
    const [treasury, float] = await Promise.all([
      incomingTxHashes.length > 0
        ? db.from("incoming_conversions").select(INCOMING_CONVERSION_COLUMNS).in("incoming_tx_hash", [...incomingTxHashes])
        : null,
      floatIncomingTxHashes.length > 0
        ? db.from("incoming_conversions").select(INCOMING_CONVERSION_COLUMNS).in("float_incoming_tx_hash", [...floatIncomingTxHashes])
        : null,
    ]);
    if (treasury?.error) throw new Error(treasury.error.message);
    if (float?.error) throw new Error(float.error.message);
    const conversions = [
      ...((treasury?.data ?? []) as IncomingConversionRow[]),
      ...((float?.data ?? []) as IncomingConversionRow[]),
    ];
    const { fees, proofs } = await loadParts(conversions.map((c) => c.id));
    return assemble(conversions, fees, proofs);
  });
}

/** All conversions for a community (Funding page). */
export function useCommunityConversions(communityId: string | null | undefined): AsyncData<ConversionView[]> {
  return useAsyncData(communityId, async () => {
    const { data, error } = await browserClient()
      .from("incoming_conversions")
      .select(INCOMING_CONVERSION_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const conversions = (data ?? []) as IncomingConversionRow[];
    const { fees, proofs } = await loadParts(conversions.map((c) => c.id));
    return assemble(conversions, fees, proofs);
  });
}
