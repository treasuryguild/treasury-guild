// Props shape for the signing panel (client-safe; built by lib/db/txPage.ts).

import type { AssetDef } from "@/lib/assets";
import type { PathTreasury } from "@/lib/cardano/spendingPaths";
import type { DecodedTxView } from "@/lib/cardano/types";
import type { SpendingPath } from "@/lib/constants";
import type { CosignerDecisionRow, PaymentRow, TreasurySignerRow } from "@/lib/db/types";
import type { SpendProblem } from "@/lib/governance/spendCheck";

export interface TxPanelTx {
  id: string;
  kind: string;
  description: string | null;
  /** The branch of the treasury script it was built for: whose signatures count. */
  spendingPath: SpendingPath;
  signedAddresses: string[];
  rejectedAddresses: string[];
  state: number;
  txHash: string | null;
  txCbor: string;
  /** What the budget check found when it was built (warn mode). */
  spendProblems: SpendProblem[];
  /**
   * When the spend TTL ends (ISO), from `valid_to_slot`; null when the build
   * has no automatic expiry (pre-TTL rows show "no expiry" when canceled).
   */
  validUntil: string | null;
}

export interface TxPanelTreasury extends PathTreasury {
  name: string;
  address: string;
  network: number;
}

export type TxPanelSigner = Pick<
  TreasurySignerRow,
  "wallet_address" | "display_name" | "key_hash" | "signer_group"
>;

export interface TxPanelProps {
  slug: string;
  tx: TxPanelTx;
  treasury: TxPanelTreasury;
  signers: TxPanelSigner[];
  decoded: DecodedTxView;
  assetRegistry: AssetDef[];
  ipfsGateway: string;
  /** The payment's rows (labels, transfer links) for a `payment` tx; empty otherwise. */
  payments: PaymentRow[];
  /** On-chain task number → number here, for tasks the chain import renumbered. */
  localTaskNumbers: Record<number, number>;
  /** Proposal number → id, for the decisions the record cites (`g`). */
  citedProposals: Record<number, string>;
  /** The app-held co-signer's decisions on a co-signed tx, newest first; empty otherwise. */
  cosignerDecisions: CosignerDecisionRow[];
  /** Whether the session wallet is an admin of the community (may ask the app co-signer to check again). */
  isAdmin: boolean;
}
