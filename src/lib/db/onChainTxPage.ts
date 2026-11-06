// Data for the read-only on-chain (external_txs) details page: the row the
// poll recorded, the treasury it spent from, and the transaction's CBOR —
// from the row when cached (migration 0087), else Koios, then persisted.
// Loaded in steps like the signing page (flat selects under RLS)—a nested
// treasuries→communities embed was failing in production and looking like
// "not found".
import "server-only";

import { resolveTxHash } from "@meshsdk/core-cst";
import {
  registryFromRows,
  COMMUNITY_ASSET_COLUMNS,
  type CommunityAssetColumns,
} from "@/lib/assetRegistry";
import type { AssetDef } from "@/lib/assets";
import { anchorProposalNumbers } from "@/lib/cardano/anchorMetadata";
import { decodeTxForDisplay } from "@/lib/cardano/cborMetadata";
import { txCborBulk } from "@/lib/cardano/koios";
import { unitsFromDecodedTx } from "@/lib/cardano/txDisplay";
import { EMPTY_TX_VIEW, type DecodedTxView } from "@/lib/cardano/types";
import { enrichRegistryFromUnits } from "@/lib/cardano/walletAssets";
import { asNetwork } from "@/lib/config";
import { TxKind } from "@/lib/constants";
import {
  governanceActionFromActivity,
  parseExternalActivity,
  type ExternalActivity,
} from "@/lib/externalActivity";
import { describeExternalTx } from "@/lib/externalTx";
import { isTxHash } from "@/lib/guards";
import {
  enrichStakeActivityLabels,
  stakeActivityLabelsChanged,
} from "@/lib/reconciliation/externalActivityEnrich";
import { displayTxDescription } from "@/lib/txDescription";
import { serviceClient } from "@/lib/db/client";
import { serverClient } from "@/lib/supabase/server";
import type { ExternalTxRow, GovernanceAction, TreasuryRow } from "./types";
import { EXTERNAL_TX_COLUMNS } from "./types";

export interface OnChainTxPageData {
  /** Community slug (URL). */
  slug: string;
  row: ExternalTxRow;
  treasury: Pick<TreasuryRow, "id" | "name" | "address" | "network">;
  /** Classifier result, or null when unrecognized / empty `{}`. */
  activity: ExternalActivity | null;
  /** List-style title (stake / registration / outgoing transfer…). */
  title: string;
  /** Stake / DRep / vote card payload when activity carries one. */
  governanceAction: GovernanceAction | null;
  /** Decoded CBOR when trusted bytes were available; empty view otherwise. */
  decoded: DecodedTxView;
  /** False when no trusted CBOR was available. */
  cborTrusted: boolean;
  assetRegistry: AssetDef[];
  /** Proposal number → id for anchor links in this community. */
  citedProposals: Record<number, string>;
}

type TreasuryColumns = Pick<
  TreasuryRow,
  "id" | "name" | "address" | "network" | "community_id"
>;

function governanceFromEnrichedActivity(
  activity: ExternalActivity | null,
): GovernanceAction | null {
  return governanceActionFromActivity(activity);
}

function logSelectError(what: string, error: { message: string } | null): void {
  if (error) console.error(`on-chain tx page: ${what}`, error.message);
}

/** Best-effort service-role write of cached CBOR and/or enriched activity. */
async function persistExternalCache(
  treasuryId: string,
  txHash: string,
  patch: { tx_cbor?: string; activity?: ExternalActivity },
): Promise<void> {
  try {
    const { error } = await serviceClient()
      .from("external_txs")
      .update(patch)
      .eq("tx_hash", txHash)
      .eq("treasury_id", treasuryId);
    if (error) console.error(`on-chain tx page: persist cache ${txHash}`, error.message);
  } catch (err) {
    console.error(`on-chain tx page: persist cache ${txHash}`, err);
  }
}

export async function loadOnChainTxPageData(
  slug: string,
  txHash: string,
): Promise<OnChainTxPageData | null> {
  if (!isTxHash(txHash)) return null;
  const hash = txHash.toLowerCase();
  const db = await serverClient();

  // Same flat select as the Treasury list (RLS: non-members get no row).
  const { data: externalRow, error: externalError } = await db
    .from("external_txs")
    .select(EXTERNAL_TX_COLUMNS)
    .eq("tx_hash", hash)
    .maybeSingle();
  logSelectError("load external_txs", externalError);
  if (externalError || !externalRow) return null;
  const row = externalRow as ExternalTxRow;

  const { data: treasuryRow, error: treasuryError } = await db
    .from("treasuries")
    .select("id, name, address, network, community_id")
    .eq("id", row.treasury_id)
    .maybeSingle();
  logSelectError("load treasury", treasuryError);
  if (treasuryError || !treasuryRow) return null;
  const treasuryFull = treasuryRow as TreasuryColumns;

  const { data: communityRow, error: communityError } = await db
    .from("communities")
    .select("slug")
    .eq("id", treasuryFull.community_id)
    .maybeSingle();
  logSelectError("load community", communityError);
  if (communityError || !communityRow || communityRow.slug !== slug) return null;

  const treasury = {
    id: treasuryFull.id,
    name: treasuryFull.name,
    address: treasuryFull.address,
    network: treasuryFull.network,
  };
  const network = asNetwork(treasury.network);

  const storedActivity = parseExternalActivity(row.activity);
  const activity = await enrichStakeActivityLabels(storedActivity, network);
  const governanceAction = governanceFromEnrichedActivity(activity);

  let title = describeExternalTx({ ...row, activity: activity ?? row.activity }).title;
  if (governanceAction?.kind === "stake") {
    title = displayTxDescription({
      description: title,
      governance_action: governanceAction,
    });
  }

  let decoded: DecodedTxView = EMPTY_TX_VIEW;
  let cborTrusted = false;
  let fetchedCbor: string | null = null;

  const cached = row.tx_cbor?.trim() || null;
  if (cached) {
    try {
      if (resolveTxHash(cached) === hash) {
        decoded = decodeTxForDisplay(cached);
        cborTrusted = true;
      }
    } catch {
      /* fall through to Koios */
    }
  }

  if (!cborTrusted) {
    try {
      const cbors = await txCborBulk(network, [hash]);
      const cbor = cbors.get(hash);
      if (cbor && resolveTxHash(cbor) === hash) {
        decoded = decodeTxForDisplay(cbor);
        cborTrusted = true;
        fetchedCbor = cbor;
      }
    } catch {
      /* leave empty view; the page shows a load error */
    }
  }

  const labelsChanged = stakeActivityLabelsChanged(storedActivity, activity);
  const cachePatch: { tx_cbor?: string; activity?: ExternalActivity } = {};
  if (fetchedCbor) cachePatch.tx_cbor = fetchedCbor;
  if (labelsChanged && activity) cachePatch.activity = activity;
  if (Object.keys(cachePatch).length > 0) {
    await persistExternalCache(row.treasury_id, hash, cachePatch);
    if (fetchedCbor) row.tx_cbor = fetchedCbor;
    if (labelsChanged && activity) row.activity = activity;
  }

  const citedNumbers = cborTrusted
    ? anchorProposalNumbers(decoded.anchorMeta)
    : activity?.kind === TxKind.Anchor
      ? (activity.proposalNumbers ?? [])
      : [];

  const [{ data: assetRows, error: assetsError }, citedResult] = await Promise.all([
    db
      .from("community_assets")
      .select(COMMUNITY_ASSET_COLUMNS)
      .eq("community_id", treasuryFull.community_id),
    citedNumbers.length > 0
      ? db
          .from("proposals")
          .select("id, number")
          .eq("community_id", treasuryFull.community_id)
          .in("number", citedNumbers)
      : Promise.resolve({ data: [] as { id: string; number: number }[], error: null }),
  ]);
  logSelectError("load community_assets", assetsError);
  logSelectError("load cited proposals", citedResult.error);

  const citedProposals: Record<number, string> = {};
  for (const p of citedResult.data ?? []) {
    citedProposals[p.number] = p.id;
  }

  const assetRegistry = await enrichRegistryFromUnits(
    network,
    registryFromRows((assetRows ?? []) as CommunityAssetColumns[]),
    unitsFromDecodedTx(decoded),
  );

  return {
    slug,
    row,
    treasury,
    activity,
    title,
    governanceAction,
    decoded,
    cborTrusted,
    assetRegistry,
    citedProposals,
  };
}
