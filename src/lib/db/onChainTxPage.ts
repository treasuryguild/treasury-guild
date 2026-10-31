// Data for the read-only on-chain (external_txs) details page: the row the
// poll recorded, the treasury it spent from, and the transaction's CBOR from
// Koios when the hash checks out. RLS: a non-member sees "not found".
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

type ExternalWithTreasury = ExternalTxRow & {
  treasuries: {
    id: string;
    name: string;
    address: string;
    network: number;
    community_id: string;
    communities: { slug: string } | { slug: string }[] | null;
  };
};

function communitySlugOf(
  communities: ExternalWithTreasury["treasuries"]["communities"],
): string | null {
  if (!communities) return null;
  const row = Array.isArray(communities) ? communities[0] : communities;
  return row?.slug ?? null;
}

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
  const enriched: GovernanceAction = {
    ...action,
    poolTicker,
    dRepName,
  };
  return enriched;
}

export async function loadOnChainTxPageData(
  slug: string,
  txHash: string,
  _viewer: string | null,
): Promise<OnChainTxPageData | null> {
  if (!isTxHash(txHash)) return null;
  const hash = txHash.toLowerCase();
  const db = await serverClient();

  // RLS on external_txs / treasuries: non-members get no row.
  const { data } = await db
    .from("external_txs")
    .select(
      `${EXTERNAL_TX_COLUMNS}, treasuries!external_txs_treasury_id_fkey!inner(id, name, address, network, community_id, communities!inner(slug))`,
    )
    .eq("tx_hash", hash)
    .maybeSingle();
  if (!data) return null;

  const joined = data as unknown as ExternalWithTreasury;
  const communitySlug = communitySlugOf(joined.treasuries.communities);
  if (!communitySlug || communitySlug !== slug) return null;

  const {
    treasuries: treasuryEmbed,
    ...rowFields
  } = joined;
  const row = rowFields as ExternalTxRow;
  const treasury = {
    id: treasuryEmbed.id,
    name: treasuryEmbed.name,
    address: treasuryEmbed.address,
    network: treasuryEmbed.network,
  };
  const network = asNetwork(treasury.network);

  const activity = parseExternalActivity(row.activity);
  let governanceAction = governanceActionFromActivity(activity);
  governanceAction = await enrichGovernanceAction(network, governanceAction);

  // Prefer enriched stake title when we resolved a ticker / DRep name.
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

  const [{ data: assetRows }, { data: cited }] = await Promise.all([
    db
      .from("community_assets")
      .select(COMMUNITY_ASSET_COLUMNS)
      .eq("community_id", treasuryEmbed.community_id),
    citedNumbers.length > 0
      ? db
          .from("proposals")
          .select("id, number")
          .eq("community_id", treasuryEmbed.community_id)
          .in("number", citedNumbers)
      : Promise.resolve({ data: [] as { id: string; number: number }[] }),
  ]);

  const citedProposals: Record<number, string> = {};
  for (const p of cited ?? []) {
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
