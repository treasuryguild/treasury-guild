// Service-role writes of funding sources and commitments (migration 0052).
// Members read them through RLS in the browser; every write is an admin
// route that authorizes first. loadFundingOverview also merges previous-wallet
// receipts (0095) so Funding Received includes pre-migration income.
import "server-only";

import { PgCode } from "@/lib/constants";
import { ConflictError } from "@/lib/errors";
import { check, maybe, must, rows, rpc, serviceClient } from "./client";
import { loadLegacyReceiptFundingInflows, loadLegacyWallets } from "./legacyHistory";
import {
  FUNDING_COMMITMENT_COLUMNS, FUNDING_PERIOD_COLUMNS, FUNDING_SOURCE_COLUMNS, type FundingAmount, type FundingCommitmentRow,
  type FundingPeriodRow, type IncomingTxRow,
  type FundingSourceRow,
} from "./types";

const NAME_TAKEN = "This community already has a funding source with that name";
const now = () => new Date().toISOString();

export async function loadFundingSource(id: string): Promise<FundingSourceRow | null> {
  return maybe<FundingSourceRow>(
    await serviceClient().from("funding_sources").select(FUNDING_SOURCE_COLUMNS).eq("id", id).maybeSingle(),
    "load funding source",
  );
}

export async function createFundingSource(row: {
  community_id: string; name: string; description: string | null; url: string | null; created_by: string;
}): Promise<FundingSourceRow> {
  const res = await serviceClient().from("funding_sources").insert(row).select(FUNDING_SOURCE_COLUMNS).single();
  if (res.error?.code === PgCode.UniqueViolation) throw new ConflictError(NAME_TAKEN);
  return must<FundingSourceRow>(res, "create funding source");
}

export async function updateFundingSource(
  id: string,
  patch: { name?: string; description?: string | null; url?: string | null },
): Promise<void> {
  const res = await serviceClient().from("funding_sources").update({ ...patch, updated_at: now() }).eq("id", id);
  if (res.error?.code === PgCode.UniqueViolation) throw new ConflictError(NAME_TAKEN);
  check(res, "update funding source");
}

/** Removes the source and its commitments; inflows tied to it are untagged. */
export async function deleteFundingSource(id: string): Promise<void> {
  check(await serviceClient().from("funding_sources").delete().eq("id", id), "delete funding source");
}

export async function loadFundingCommitment(id: string): Promise<FundingCommitmentRow | null> {
  return maybe<FundingCommitmentRow>(
    await serviceClient().from("funding_commitments").select(FUNDING_COMMITMENT_COLUMNS).eq("id", id).maybeSingle(),
    "load funding commitment",
  );
}

export async function createFundingCommitment(row: Omit<FundingCommitmentRow, "id" | "created_at" | "updated_at">): Promise<FundingCommitmentRow> {
  return must<FundingCommitmentRow>(
    await serviceClient().from("funding_commitments").insert(row).select(FUNDING_COMMITMENT_COLUMNS).single(),
    "create funding commitment",
  );
}

export async function updateFundingCommitment(
  id: string,
  patch: Partial<Pick<FundingCommitmentRow, "name" | "url" | "note" | "starts_on" | "ends_on" | "amounts">>,
): Promise<void> {
  check(
    await serviceClient().from("funding_commitments").update({ ...patch, updated_at: now() }).eq("id", id),
    "update funding commitment",
  );
}

export async function deleteFundingCommitment(id: string): Promise<void> {
  check(await serviceClient().from("funding_commitments").delete().eq("id", id), "delete funding commitment");
}

/** The periods of one schedule, oldest first. */
export async function loadFundingPeriods(commitmentId: string): Promise<FundingPeriodRow[]> {
  return rows<FundingPeriodRow>(
    await serviceClient()
      .from("funding_commitment_periods")
      .select(FUNDING_PERIOD_COLUMNS)
      .eq("commitment_id", commitmentId)
      .order("starts_on"),
    "load funding periods",
  );
}

/** Replaces every period of a schedule at once (`save_funding_schedule`). */
export async function saveFundingSchedule(
  commitmentId: string,
  periods: { startsOn: string; amounts: FundingAmount[] }[],
): Promise<number> {
  return rpc<number>(await serviceClient().rpc("save_funding_schedule", { p_commitment_id: commitmentId, p_periods: periods }));
}

/** Is this source in the community (for tagging an inflow)? */
export async function fundingSourceCommunity(sourceId: string): Promise<string | null> {
  return (await loadFundingSource(sourceId))?.community_id ?? null;
}

/** One funded inflow on the Funding page (chain or previous-wallet receipt). */
export interface FundingOverviewInflow {
  tx_hash: string;
  treasury_id: string;
  amount_lovelace: string;
  assets: Record<string, string> | null;
  block_time: string | null;
  funding_source_id: string;
  funding_commitment_id: string | null;
}

/** Everything the Funding page reads, for the agent API: sources, commitments, schedules, tagged inflows. */
export type FundingOverview = {
  sources: FundingSourceRow[];
  commitments: FundingCommitmentRow[];
  periods: FundingPeriodRow[];
  inflows: FundingOverviewInflow[];
  /** Previous wallets, so receipt inflows can be labelled on the Funding page. */
  legacyWallets: { id: string; name: string }[];
};

/** The same reads as the Funding page, as the service role (includes previous-wallet receipts). */
export async function loadFundingOverview(communityId: string, treasuryIds: readonly string[]): Promise<FundingOverview> {
  const db = serviceClient();
  const [sources, commitments, legacyWallets, receiptInflows] = await Promise.all([
    db.from("funding_sources").select(FUNDING_SOURCE_COLUMNS).eq("community_id", communityId).order("name"),
    db.from("funding_commitments").select(FUNDING_COMMITMENT_COLUMNS).eq("community_id", communityId).order("created_at"),
    loadLegacyWallets(communityId),
    loadLegacyReceiptFundingInflows(communityId),
  ]);
  const commitmentRows = rows<FundingCommitmentRow>(commitments, "load funding commitments");
  const scheduleIds = commitmentRows.filter((c) => c.kind === "schedule").map((c) => c.id);
  const [periods, inflows] = await Promise.all([
    scheduleIds.length > 0
      ? db.from("funding_commitment_periods").select(FUNDING_PERIOD_COLUMNS).in("commitment_id", scheduleIds).order("starts_on")
      : null,
    treasuryIds.length > 0
      ? db.from("incoming_txs")
        .select("tx_hash, treasury_id, amount_lovelace, assets, block_time, funding_source_id, funding_commitment_id")
        .in("treasury_id", [...treasuryIds])
        .not("funding_source_id", "is", null)
      : null,
  ]);
  const chain = inflows
    ? rows<Pick<IncomingTxRow, "tx_hash" | "treasury_id" | "amount_lovelace" | "assets" | "block_time" | "funding_source_id" | "funding_commitment_id">>(
      inflows,
      "load funded inflows",
    ).map((row) => ({
      tx_hash: row.tx_hash,
      treasury_id: row.treasury_id,
      amount_lovelace: row.amount_lovelace,
      assets: row.assets,
      block_time: row.block_time,
      funding_source_id: row.funding_source_id!,
      funding_commitment_id: row.funding_commitment_id,
    }))
    : [];
  const receipts: FundingOverviewInflow[] = receiptInflows.map((r) => ({
    tx_hash: r.txHash,
    treasury_id: r.treasuryId,
    amount_lovelace: r.amountLovelace,
    assets: r.assets,
    block_time: r.blockTime,
    funding_source_id: r.sourceId,
    funding_commitment_id: r.commitmentId,
  }));
  return {
    sources: rows<FundingSourceRow>(sources, "load funding sources"),
    commitments: commitmentRows,
    periods: periods ? rows<FundingPeriodRow>(periods, "load funding periods") : [],
    inflows: [...chain, ...receipts],
    legacyWallets: legacyWallets.map((w) => ({ id: w.id, name: w.name })),
  };
}
