// Data for the read-only on-chain (external_txs) details page: the row the
// poll recorded, the treasury it spent from, and the transaction's CBOR from
// Koios when the hash checks out. Loaded in steps like the signing page
// (flat selects under RLS)—a nested treasuries→communities embed was failing
// in production and looking like "not found".
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
import { lookupDrep, lookupStakePool, txCborBulk } from "@/lib/cardano/koios";
import { EMPTY_TX_VIEW, type DecodedTxView } from "@/lib/cardano/types";
import { asNetwork, type Network } from "@/lib/config";
import { StakeAction, TxKind } from "@/lib/constants";
import {
  governanceActionFromActivity,
  parseExternalActivity,
  type ExternalActivity,
} from "@/lib/externalActivity";
import { describeExternalTx } from "@/lib/externalTx";
import { isTxHash } from "@/lib/guards";
import { displayTxDescription } from "@/lib/txDescription";
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
  /** Decoded CBOR when Koios had trusted bytes; empty view otherwise. */
  decoded: DecodedTxView;
  /** False when Koios had no CBOR or the hash did not match. */
  cborTrusted: boolean;
  assetRegistry: AssetDef[];
  /** Proposal number → id for anchor links in this community. */
  citedProposals: Record<number, string>;
}

type TreasuryColumns = Pick<
  TreasuryRow,
  "id" | "name" | "address" | "network" | "community_id"
>;

async function enrichGovernanceAction(
  network: Network,
  action: GovernanceAction | null,
): Promise<GovernanceAction | null> {
  if (!action || action.kind !== "stake") return action;
  let poolTicker = action.poolTicker?.trim() || null;
  let dRepName = action.dRepName?.trim() || null;
  if (action.poolId && !poolTicker) {
    try {
      poolTicker = (await lookupStakePool(network, action.poolId))?.ticker ?? null;
    } catch {
      /* keep pool id */
    }
  }
  if (
    action.action === StakeAction.VoteDelegation &&
    action.dRepId?.trim() &&
    !dRepName
  ) {
    try {
      dRepName = (await lookupDrep(network, action.dRepId))?.givenName ?? null;
    } catch {
      /* keep dRep id */
    }
  }
  return { ...action, poolTicker, dRepName };
}

function logSelectError(what: string, error: { message: string } | null): void {
  if (error) console.error(`on-chain tx page: ${what}`, error.message);
}

export async function loadOnChainTxPageData(
  slug: string,
  txHash: string,
  _viewer: string | null,
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

  const activity = parseExternalActivity(row.activity);
  let governanceAction = governanceActionFromActivity(activity);
  governanceAction = await enrichGovernanceAction(network, governanceAction);

  let title = describeExternalTx(row).title;
  if (governanceAction?.kind === "stake") {
    title = displayTxDescription({
      description: title,
      governance_action: governanceAction,
    });
  }

  let decoded: DecodedTxView = EMPTY_TX_VIEW;
  let cborTrusted = false;
  try {
    const cbors = await txCborBulk(network, [hash]);
    const cbor = cbors.get(hash);
    if (cbor && resolveTxHash(cbor) === hash) {
      decoded = decodeTxForDisplay(cbor);
      cborTrusted = true;
    }
  } catch {
    /* leave empty view; the page shows a load error */
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

  return {
    slug,
    row,
    treasury,
    activity,
    title,
    governanceAction,
    decoded,
    cborTrusted,
    assetRegistry: registryFromRows((assetRows ?? []) as CommunityAssetColumns[]),
    citedProposals,
  };
}
