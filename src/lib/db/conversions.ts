// Service-role reads and writes for bridge/swap conversion episodes (0089).
import "server-only";

import { PgCode } from "@/lib/constants";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { check, maybe, must, relation, rows, serviceClient } from "./client";
import {
  INCOMING_CONVERSION_COLUMNS,
  INCOMING_CONVERSION_FEE_COLUMNS,
  INCOMING_CONVERSION_PROOF_COLUMNS,
  type ConversionChain,
  type ConversionFeeKind,
  type ConversionKind,
  type IncomingConversionFeeRow,
  type IncomingConversionProofRow,
  type IncomingConversionRow,
} from "./types";

export type ConversionFeeInput = {
  kind: ConversionFeeKind;
  amount: string;
  asset_label: string;
  chain: ConversionChain | null;
};

export type ConversionProofInput = {
  chain: ConversionChain;
  tx_hash: string;
  url: string | null;
  label: string | null;
};

export type ConversionWithParts = IncomingConversionRow & {
  fees: IncomingConversionFeeRow[];
  proofs: IncomingConversionProofRow[];
  /** Linked Cardano inflow block time (for windowed fee totals). */
  block_time: string | null;
};

export async function loadConversion(id: string): Promise<IncomingConversionRow | null> {
  return maybe<IncomingConversionRow>(
    await serviceClient().from("incoming_conversions").select(INCOMING_CONVERSION_COLUMNS).eq("id", id).maybeSingle(),
    "load conversion",
  );
}

export async function requireConversion(id: string): Promise<IncomingConversionRow> {
  const row = await loadConversion(id);
  if (!row) throw new NotFoundError("Conversion not found");
  return row;
}

async function loadParts(conversionIds: readonly string[]): Promise<{
  fees: IncomingConversionFeeRow[];
  proofs: IncomingConversionProofRow[];
}> {
  if (conversionIds.length === 0) return { fees: [], proofs: [] };
  const db = serviceClient();
  const [fees, proofs] = await Promise.all([
    db.from("incoming_conversion_fees")
      .select(INCOMING_CONVERSION_FEE_COLUMNS)
      .in("conversion_id", [...conversionIds])
      .order("position"),
    db.from("incoming_conversion_proofs")
      .select(INCOMING_CONVERSION_PROOF_COLUMNS)
      .in("conversion_id", [...conversionIds])
      .order("position"),
  ]);
  return {
    fees: rows<IncomingConversionFeeRow>(fees, "load conversion fees"),
    proofs: rows<IncomingConversionProofRow>(proofs, "load conversion proofs"),
  };
}

function attachParts(
  conversions: IncomingConversionRow[],
  fees: IncomingConversionFeeRow[],
  proofs: IncomingConversionProofRow[],
  blockTimeById: Map<string, string | null>,
): ConversionWithParts[] {
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
    block_time: blockTimeById.get(c.id) ?? null,
  }));
}

/** Episodes for a community, newest first, with fees/proofs and inflow times. */
export async function loadCommunityConversions(communityId: string): Promise<ConversionWithParts[]> {
  const conversions = rows<IncomingConversionRow>(
    await serviceClient()
      .from("incoming_conversions")
      .select(INCOMING_CONVERSION_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at", { ascending: false }),
    "load community conversions",
  );
  if (conversions.length === 0) return [];
  const { fees, proofs } = await loadParts(conversions.map((c) => c.id));
  const blockTimeById = await loadBlockTimes(conversions);
  return attachParts(conversions, fees, proofs, blockTimeById);
}

async function loadBlockTimes(conversions: IncomingConversionRow[]): Promise<Map<string, string | null>> {
  const treasuryHashes = conversions.filter((c) => c.incoming_tx_hash).map((c) => c.incoming_tx_hash!);
  const floatHashes = conversions.filter((c) => c.float_incoming_tx_hash).map((c) => c.float_incoming_tx_hash!);
  const db = serviceClient();
  const [treasury, float] = await Promise.all([
    treasuryHashes.length > 0
      ? db.from("incoming_txs").select("tx_hash, block_time").in("tx_hash", treasuryHashes)
      : null,
    floatHashes.length > 0
      ? db.from("float_incoming_txs").select("tx_hash, block_time").in("tx_hash", floatHashes)
      : null,
  ]);
  const byHash = new Map<string, string | null>();
  for (const row of treasury ? rows<{ tx_hash: string; block_time: string | null }>(treasury, "load conversion inflow times") : []) {
    byHash.set(`t:${row.tx_hash}`, row.block_time);
  }
  for (const row of float ? rows<{ tx_hash: string; block_time: string | null }>(float, "load float conversion inflow times") : []) {
    byHash.set(`f:${row.tx_hash}`, row.block_time);
  }
  const out = new Map<string, string | null>();
  for (const c of conversions) {
    const key = c.incoming_tx_hash ? `t:${c.incoming_tx_hash}` : `f:${c.float_incoming_tx_hash}`;
    out.set(c.id, byHash.get(key) ?? null);
  }
  return out;
}

/** Episodes attached to the given treasury or float inflow hashes. */
export async function loadConversionsForInflows(opts: {
  incomingTxHashes?: readonly string[];
  floatIncomingTxHashes?: readonly string[];
}): Promise<ConversionWithParts[]> {
  const incoming = opts.incomingTxHashes ?? [];
  const floatIncoming = opts.floatIncomingTxHashes ?? [];
  if (incoming.length === 0 && floatIncoming.length === 0) return [];
  const db = serviceClient();
  const [a, b] = await Promise.all([
    incoming.length > 0
      ? db.from("incoming_conversions").select(INCOMING_CONVERSION_COLUMNS).in("incoming_tx_hash", [...incoming])
      : null,
    floatIncoming.length > 0
      ? db.from("incoming_conversions").select(INCOMING_CONVERSION_COLUMNS).in("float_incoming_tx_hash", [...floatIncoming])
      : null,
  ]);
  const conversions = [
    ...(a ? rows<IncomingConversionRow>(a, "load conversions by treasury inflow") : []),
    ...(b ? rows<IncomingConversionRow>(b, "load conversions by float inflow") : []),
  ];
  if (conversions.length === 0) return [];
  const { fees, proofs } = await loadParts(conversions.map((c) => c.id));
  const blockTimeById = await loadBlockTimes(conversions);
  return attachParts(conversions, fees, proofs, blockTimeById);
}

/** Resolve which community owns a treasury or float inflow. */
export async function communityIdForInflow(attach: {
  incomingTxHash?: string | null;
  floatIncomingTxHash?: string | null;
}): Promise<string> {
  if (attach.incomingTxHash) {
    const row = maybe<{ treasuries: { community_id: string } | { community_id: string }[] }>(
      await serviceClient()
        .from("incoming_txs")
        .select("treasuries!inner(community_id)")
        .eq("tx_hash", attach.incomingTxHash)
        .maybeSingle(),
      "load inflow community",
    );
    if (!row) throw new NotFoundError("Incoming transaction not found");
    return relation(row.treasuries).community_id;
  }
  if (attach.floatIncomingTxHash) {
    const row = maybe<{
      float_wallets: { community_id: string } | { community_id: string }[];
    }>(
      await serviceClient()
        .from("float_incoming_txs")
        .select("float_wallets!inner(community_id)")
        .eq("tx_hash", attach.floatIncomingTxHash)
        .maybeSingle(),
      "load float inflow community",
    );
    if (!row) throw new NotFoundError("Float incoming transaction not found");
    return relation(row.float_wallets).community_id;
  }
  throw new NotFoundError("Incoming transaction not found");
}

async function replaceParts(
  conversionId: string,
  fees: readonly ConversionFeeInput[],
  proofs: readonly ConversionProofInput[],
): Promise<void> {
  const db = serviceClient();
  check(await db.from("incoming_conversion_fees").delete().eq("conversion_id", conversionId), "clear conversion fees");
  check(await db.from("incoming_conversion_proofs").delete().eq("conversion_id", conversionId), "clear conversion proofs");
  if (fees.length > 0) {
    check(
      await db.from("incoming_conversion_fees").insert(
        fees.map((f, position) => ({
          conversion_id: conversionId,
          kind: f.kind,
          amount: f.amount,
          asset_label: f.asset_label.trim(),
          chain: f.chain,
          position,
        })),
      ),
      "insert conversion fees",
    );
  }
  if (proofs.length > 0) {
    check(
      await db.from("incoming_conversion_proofs").insert(
        proofs.map((p, position) => ({
          conversion_id: conversionId,
          chain: p.chain,
          tx_hash: p.tx_hash.trim(),
          url: p.url,
          label: p.label?.trim() || null,
          position,
        })),
      ),
      "insert conversion proofs",
    );
  }
}

export async function createConversion(input: {
  community_id: string;
  kind: ConversionKind;
  incoming_tx_hash: string | null;
  float_incoming_tx_hash: string | null;
  sent_amount: string;
  sent_asset_label: string;
  sent_chain: ConversionChain;
  sent_address: string | null;
  note: string | null;
  created_by: string;
  fees: readonly ConversionFeeInput[];
  proofs: readonly ConversionProofInput[];
}): Promise<IncomingConversionRow> {
  const { fees, proofs, ...row } = input;
  const res = await serviceClient()
    .from("incoming_conversions")
    .insert({
      ...row,
      sent_asset_label: row.sent_asset_label.trim(),
      sent_address: row.sent_address?.trim() || null,
      note: row.note?.trim() || null,
    })
    .select(INCOMING_CONVERSION_COLUMNS)
    .single();
  if (res.error?.code === PgCode.UniqueViolation) {
    throw new ConflictError("This inflow already has a conversion record");
  }
  const created = must<IncomingConversionRow>(res, "create conversion");
  await replaceParts(created.id, fees, proofs);
  return created;
}

export async function updateConversion(
  id: string,
  patch: {
    kind: ConversionKind;
    sent_amount: string;
    sent_asset_label: string;
    sent_chain: ConversionChain;
    sent_address: string | null;
    note: string | null;
    fees: readonly ConversionFeeInput[];
    proofs: readonly ConversionProofInput[];
  },
): Promise<void> {
  const { fees, proofs, ...fields } = patch;
  check(
    await serviceClient()
      .from("incoming_conversions")
      .update({
        ...fields,
        sent_asset_label: fields.sent_asset_label.trim(),
        sent_address: fields.sent_address?.trim() || null,
        note: fields.note?.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id),
    "update conversion",
  );
  await replaceParts(id, fees, proofs);
}

export async function deleteConversion(id: string): Promise<void> {
  check(await serviceClient().from("incoming_conversions").delete().eq("id", id), "delete conversion");
}
