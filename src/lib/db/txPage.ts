// Data for the transaction page, read through the RLS client so a
// non-member simply sees "not found".
import "server-only";

import { registryFromRows, COMMUNITY_ASSET_COLUMNS, type CommunityAssetColumns } from "@/lib/assetRegistry";
import type { AssetDef } from "@/lib/assets";
import { anchorProposalNumbers } from "@/lib/cardano/anchorMetadata";
import { extractAnchorMetadata, extractPayoutMetadata } from "@/lib/cardano/cborMetadata";
import { lookupDrep, lookupStakePool } from "@/lib/cardano/koios";
import { citedProposalNumbers } from "@/lib/cardano/metadata";
import { slotTime } from "@/lib/cardano/slots";
import type { Network } from "@/lib/config";
import { asNetwork } from "@/lib/config";
import { SpendingPath, StakeAction, TxKind } from "@/lib/constants";
import { isAdminRole } from "@/lib/roles";
import { serverClient } from "@/lib/supabase/server";
import { displayTxDescription } from "@/lib/txDescription";
import type { TxPanelSigner, TxPanelTreasury, TxPanelTx } from "@/components/tx/types";
import {
  COSIGNER_DECISION_COLUMNS,
  PAYMENT_COLUMNS,
  type CosignerDecisionRow,
  type GovernanceAction,
  type PaymentRow,
  type TransactionRow,
  type TreasuryRow,
} from "./types";

/**
 * Title for the signing page: prefer the pool ticker / DRep givenName over a
 * baked-in id (older rows stored the id in `description` before lookups).
 */
async function stakePageDescription(
  network: Network,
  action: GovernanceAction | null,
  fallback: string | null,
): Promise<string> {
  const tickers = new Map<string, string>();
  const dRepNames = new Map<string, string>();
  if (action?.kind === "stake" && action.poolId && !action.poolTicker?.trim()) {
    try {
      const ticker = (await lookupStakePool(network, action.poolId))?.ticker;
      if (ticker) tickers.set(action.poolId, ticker);
    } catch {
      /* keep the stored description / pool id */
    }
  }
  if (
    action?.kind === "stake" &&
    action.action === StakeAction.VoteDelegation &&
    action.dRepId?.trim() &&
    !action.dRepName?.trim()
  ) {
    try {
      const name = (await lookupDrep(network, action.dRepId))?.givenName;
      if (name) dRepNames.set(action.dRepId.trim(), name);
    } catch {
      /* keep the stored description / dRep id */
    }
  }
  return displayTxDescription(
    { description: fallback, governance_action: action },
    { poolTickerById: tickers, dRepNameById: dRepNames },
  );
}

export interface TxPageData {
  tx: TxPanelTx;
  treasury: TxPanelTreasury;
  signers: TxPanelSigner[];
  assetRegistry: AssetDef[];
  /** Recipient labels and transfer links of a payment tx; empty for other kinds. */
  payments: PaymentRow[];
  /**
   * Tasks of a payout that the chain import created under a new number: the
   * number the on-chain record names → the task's number here.
   */
  localTaskNumbers: Record<number, number>;
  /** The proposals the records name (`g` citations, label-190002 anchors) that exist here: number → id. */
  citedProposals: Record<number, string>;
  /** The app-held co-signer's decisions on a co-signed tx, newest first. */
  cosignerDecisions: CosignerDecisionRow[];
  /** Whether the viewer is an admin of the community. */
  isAdmin: boolean;
}

type TreasuryColumns = Pick<
  TreasuryRow,
  "name" | "address" | "required" | "script_type" | "network" | "community_id" | "template" | "lock_until"
  | "recovery_script_type" | "recovery_required" | "cosigner_kind"
>;

export async function loadTxPageData(txId: string, viewer: string | null): Promise<TxPageData | null> {
  const db = await serverClient();

  const { data: tx } = await db
    .from("transactions")
    .select("*")
    .eq("id", txId)
    .maybeSingle();
  if (!tx) return null;
  const row = tx as TransactionRow;

  const { data: treasuryRow } = await db
    .from("treasuries")
    .select("name, address, required, script_type, network, community_id, template, lock_until, recovery_script_type, recovery_required, cosigner_kind")
    .eq("id", row.treasury_id)
    .maybeSingle();
  if (!treasuryRow) return null;
  const treasury = treasuryRow as TreasuryColumns;

  const citedNumbers = [...new Set([
    ...citedProposalNumbers(extractPayoutMetadata(row.tx_cbor)),
    ...anchorProposalNumbers(extractAnchorMetadata(row.tx_cbor)),
  ])];
  const [{ data: signers }, { data: assetRows }, { data: paymentRows }, { data: renumbered }, { data: cited }, { data: decisions }, { data: member }] = await Promise.all([
    db
      .from("treasury_signers")
      .select("wallet_address, display_name, key_hash, signer_group")
      .eq("treasury_id", row.treasury_id),
    db
      .from("community_assets")
      .select(COMMUNITY_ASSET_COLUMNS)
      .eq("community_id", treasury.community_id),
    row.kind === TxKind.Payment
      ? db.from("payments").select(PAYMENT_COLUMNS).eq("transaction_id", row.id).order("id")
      : Promise.resolve({ data: [] as PaymentRow[] }),
    row.kind === TxKind.Payout
      ? db
          .from("payouts")
          .select("tasks!inner(number, chain_number)")
          .eq("transaction_id", row.id)
          .not("tasks.chain_number", "is", null)
      : Promise.resolve({ data: [] }),
    citedNumbers.length > 0
      ? db.from("proposals").select("id, number").eq("community_id", treasury.community_id).in("number", citedNumbers)
      : Promise.resolve({ data: [] as { id: string; number: number }[] }),
    row.spending_path === SpendingPath.Cosigned
      ? db.from("cosigner_decisions").select(COSIGNER_DECISION_COLUMNS).eq("transaction_id", row.id).order("decided_at", { ascending: false })
      : Promise.resolve({ data: [] as CosignerDecisionRow[] }),
    viewer
      ? db.from("community_members").select("role").eq("community_id", treasury.community_id).eq("wallet_address", viewer).maybeSingle()
      : Promise.resolve({ data: null as { role: string } | null }),
  ]);
  const citedProposals: Record<number, string> = {};
  for (const p of (cited ?? []) as { id: string; number: number }[]) citedProposals[p.number] = p.id;
  const localTaskNumbers: Record<number, number> = {};
  for (const payout of (renumbered ?? []) as unknown as { tasks: { number: number; chain_number: number } }[]) {
    const task = payout.tasks;
    if (task.chain_number !== task.number) localTaskNumbers[task.chain_number] = task.number;
  }

  const network = asNetwork(treasury.network);
  const description = await stakePageDescription(network, row.governance_action, row.description);

  return {
    tx: {
      id: row.id,
      kind: row.kind,
      description,
      spendingPath: row.spending_path,
      signedAddresses: row.signed_addresses,
      rejectedAddresses: row.rejected_addresses,
      state: row.state,
      txHash: row.tx_hash,
      txCbor: row.tx_cbor,
      spendProblems: row.spend_problems ?? [],
      validUntil: row.valid_to_slot != null
        ? slotTime(network, Number(row.valid_to_slot))
        : null,
      governanceAction: row.governance_action,
    },
    treasury: {
      name: treasury.name,
      address: treasury.address,
      required: treasury.required,
      script_type: treasury.script_type,
      network: treasury.network,
      template: treasury.template,
      lock_until: treasury.lock_until,
      recovery_script_type: treasury.recovery_script_type,
      recovery_required: treasury.recovery_required,
      cosigner_kind: treasury.cosigner_kind,
    },
    signers: (signers ?? []) as TxPanelSigner[],
    assetRegistry: registryFromRows((assetRows ?? []) as CommunityAssetColumns[]),
    payments: (paymentRows ?? []) as PaymentRow[],
    localTaskNumbers,
    citedProposals,
    cosignerDecisions: (decisions ?? []) as CosignerDecisionRow[],
    isAdmin: isAdminRole((member as { role: string } | null)?.role),
  };
}
