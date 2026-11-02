// Service-role reads and writes for watched float wallets (migration 0088).
import "server-only";

import { MAX_FLOAT_WALLETS, PgCode } from "@/lib/constants";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { check, maybe, must, relation, rows, serviceClient } from "./client";
import {
  FLOAT_EXTERNAL_TX_COLUMNS,
  FLOAT_INCOMING_TX_COLUMNS,
  FLOAT_WALLET_COLUMNS,
  type FloatExternalTxRow,
  type FloatIncomingTxRow,
  type FloatWalletRow,
} from "./types";

export async function loadFloatWallet(id: string): Promise<FloatWalletRow | null> {
  return maybe<FloatWalletRow>(
    await serviceClient().from("float_wallets").select(FLOAT_WALLET_COLUMNS).eq("id", id).maybeSingle(),
    "load float wallet",
  );
}

export async function requireFloatWallet(id: string): Promise<FloatWalletRow> {
  const row = await loadFloatWallet(id);
  if (!row) throw new NotFoundError("Float wallet not found");
  return row;
}

export async function loadFloatWallets(communityId: string): Promise<FloatWalletRow[]> {
  return rows<FloatWalletRow>(
    await serviceClient()
      .from("float_wallets")
      .select(FLOAT_WALLET_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at"),
    "load float wallets",
  );
}

/** Non-archived floats usable as payment transfer recipients and funding-flow nodes. */
export async function loadActiveFloatWallets(communityId: string): Promise<FloatWalletRow[]> {
  return rows<FloatWalletRow>(
    await serviceClient()
      .from("float_wallets")
      .select(FLOAT_WALLET_COLUMNS)
      .eq("community_id", communityId)
      .is("archived_at", null)
      .order("created_at"),
    "load active float wallets",
  );
}

export async function countActiveFloatWallets(communityId: string): Promise<number> {
  const res = await serviceClient()
    .from("float_wallets")
    .select("id", { count: "exact", head: true })
    .eq("community_id", communityId)
    .is("archived_at", null);
  check(res, "count active float wallets");
  return res.count ?? 0;
}

const ADDRESS_TAKEN = "This community already watches that address";
const ADDRESS_IS_TREASURY = "That address is already one of this community's treasuries";
const AT_CAP = `A community can watch at most ${MAX_FLOAT_WALLETS} float wallets`;

export async function createFloatWallet(row: {
  community_id: string;
  name: string;
  address: string;
  note: string | null;
  created_by: string;
}): Promise<FloatWalletRow> {
  const active = await countActiveFloatWallets(row.community_id);
  if (active >= MAX_FLOAT_WALLETS) throw new ConflictError(AT_CAP);

  const treasuryHit = maybe<{ id: string }>(
    await serviceClient()
      .from("treasuries")
      .select("id")
      .eq("community_id", row.community_id)
      .eq("address", row.address)
      .maybeSingle(),
    "check treasury address clash",
  );
  if (treasuryHit) throw new ConflictError(ADDRESS_IS_TREASURY);

  const res = await serviceClient().from("float_wallets").insert(row).select(FLOAT_WALLET_COLUMNS).single();
  if (res.error?.code === PgCode.UniqueViolation) throw new ConflictError(ADDRESS_TAKEN);
  return must<FloatWalletRow>(res, "create float wallet");
}

export async function updateFloatWallet(
  id: string,
  patch: { name?: string; note?: string | null },
): Promise<void> {
  check(
    await serviceClient().from("float_wallets").update(patch).eq("id", id),
    "update float wallet",
  );
}

export async function archiveFloatWallet(id: string, archivedBy: string): Promise<void> {
  check(
    await serviceClient()
      .from("float_wallets")
      .update({ archived_at: new Date().toISOString(), archived_by: archivedBy })
      .eq("id", id)
      .is("archived_at", null),
    "archive float wallet",
  );
}

export async function restoreFloatWallet(id: string): Promise<void> {
  const row = await requireFloatWallet(id);
  if (!row.archived_at) return;
  const active = await countActiveFloatWallets(row.community_id);
  if (active >= MAX_FLOAT_WALLETS) throw new ConflictError(AT_CAP);
  check(
    await serviceClient()
      .from("float_wallets")
      .update({ archived_at: null, archived_by: null })
      .eq("id", id),
    "restore float wallet",
  );
}

export async function tagFloatTransfers(communityId: string): Promise<void> {
  const { error } = await serviceClient().rpc("tag_float_transfers", { p_community_id: communityId });
  if (error) console.error(`tag_float_transfers ${communityId} failed`, error);
}

export async function loadFloatIncoming(
  floatWalletId: string,
  limit = 50,
): Promise<FloatIncomingTxRow[]> {
  return rows<FloatIncomingTxRow>(
    await serviceClient()
      .from("float_incoming_txs")
      .select(FLOAT_INCOMING_TX_COLUMNS)
      .eq("float_wallet_id", floatWalletId)
      .order("block_time", { ascending: false })
      .limit(limit),
    "load float incoming",
  );
}

export async function loadFloatExternal(
  floatWalletId: string,
  limit = 50,
): Promise<FloatExternalTxRow[]> {
  return rows<FloatExternalTxRow>(
    await serviceClient()
      .from("float_external_txs")
      .select(FLOAT_EXTERNAL_TX_COLUMNS)
      .eq("float_wallet_id", floatWalletId)
      .order("block_time", { ascending: false })
      .limit(limit),
    "load float external",
  );
}

export type FloatWalletForSync = Pick<FloatWalletRow, "id" | "community_id" | "address"> & {
  network: number;
};

/** Every float of every community (reconcile sweep), with the community network. */
export async function listAllFloatWalletsForSync(): Promise<FloatWalletForSync[]> {
  const rowsRaw = rows<
    Pick<FloatWalletRow, "id" | "community_id" | "address"> & { communities: { network: number } | { network: number }[] }
  >(
    await serviceClient()
      .from("float_wallets")
      .select("id, community_id, address, communities!inner(network)"),
    "list float wallets for sync",
  );
  return rowsRaw.map((r) => ({
    id: r.id,
    community_id: r.community_id,
    address: r.address,
    network: relation(r.communities).network,
  }));
}

export async function listCommunityFloatWalletsForSync(
  communityId: string,
): Promise<FloatWalletForSync[]> {
  const community = maybe<{ network: number }>(
    await serviceClient().from("communities").select("network").eq("id", communityId).maybeSingle(),
    "load community network for float sync",
  );
  if (!community) return [];
  const floats = rows<Pick<FloatWalletRow, "id" | "community_id" | "address">>(
    await serviceClient()
      .from("float_wallets")
      .select("id, community_id, address")
      .eq("community_id", communityId),
    "list community float wallets for sync",
  );
  return floats.map((f) => ({ ...f, network: community.network }));
}
