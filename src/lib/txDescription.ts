// The one-line `transactions.description` of a payout and of a manual payment.
// Shared by the build routes and the chain import, so a transaction rebuilt
// from the chain reads like the one the app would have built.

import { DrepAction, StakeAction } from "@/lib/constants";
import type { GovernanceAction } from "@/lib/db/types";
import { plural } from "@/lib/format";

/** "3 recipients", or "2 treasury transfers" when every recipient is a sibling treasury. */
export function paymentRecipientSummary(p: { recipients: number; transfers: number }): string {
  return p.transfers === p.recipients
    ? plural(p.transfers, "treasury transfer")
    : plural(p.recipients, "recipient");
}

export function payoutDescription(p: {
  tasks: number;
  payments: number;
  contributors: number;
  tickers: readonly string[];
}): string {
  return `Payout: ${p.tasks} tasks, ${p.payments} payments, ${p.contributors} contributors (${p.tickers.join(", ")})`;
}

/** "Anchors: proposals #3, #4" for a dedicated anchor transaction. */
export function anchorDescription(proposalNumbers: readonly number[]): string {
  const numbers = [...new Set(proposalNumbers)].sort((a, b) => a - b);
  return `Anchors: ${numbers.length === 1 ? "proposal" : "proposals"} ${numbers.map((n) => `#${n}`).join(", ")}`;
}

/** Fixed description so pending registration txs are recognisable on the details modal. */
export const REGISTRATION_TX_DESCRIPTION = "CIP-0146 wallet registration";

export function registrationDescription(): string {
  return REGISTRATION_TX_DESCRIPTION;
}

export function paymentDescription(p: {
  memo: string | null;
  recipients: number;
  /** How many of the recipients are the community's other treasuries. */
  transfers: number;
  tickers: readonly string[];
}): string {
  const what = paymentRecipientSummary(p);
  return `Payment: ${p.memo ? `${p.memo}, ` : ""}${what} (${p.tickers.join(", ")})`;
}

/** Prefer the pool ticker (name) in titles; pool id lives in transaction details. */
export function stakePoolLabel(detail?: {
  poolId?: string | null;
  poolTicker?: string | null;
}): string | null {
  const ticker = detail?.poolTicker?.trim();
  if (ticker) return ticker;
  const poolId = detail?.poolId?.trim();
  return poolId || null;
}

export function stakeDescription(
  action: StakeAction,
  detail?: { poolId?: string | null; poolTicker?: string | null; dRepId?: string | null },
): string {
  const pool = stakePoolLabel(detail);
  switch (action) {
    case StakeAction.Register:
      return "Stake: register";
    case StakeAction.RegisterAndDelegate:
      return `Stake: register and delegate${pool ? ` to ${pool}` : ""}`;
    case StakeAction.Delegate:
      return `Stake: delegate${pool ? ` to ${pool}` : ""}`;
    case StakeAction.Deregister:
      return "Stake: deregister";
    case StakeAction.Withdraw:
      return "Stake: withdraw rewards";
    case StakeAction.VoteDelegation:
      return `Stake: vote delegation${detail?.dRepId ? ` to ${detail.dRepId}` : ""}`;
    default:
      return "Stake";
  }
}

/**
 * List / page title for a transaction. Stake rows prefer a known ticker
 * (`governance_action.poolTicker` or `poolTickerById`) over a baked-in pool id.
 */
export function displayTxDescription(
  tx: { description: string | null; governance_action?: GovernanceAction | null },
  poolTickerById?: ReadonlyMap<string, string>,
): string {
  const action = tx.governance_action;
  if (action?.kind === "stake") {
    const fromMap = action.poolId ? poolTickerById?.get(action.poolId) : null;
    return stakeDescription(action.action, {
      poolId: action.poolId,
      poolTicker: action.poolTicker?.trim() || fromMap || null,
      dRepId: action.dRepId,
    });
  }
  return tx.description ?? "Transaction";
}

/** Pool ids on stake txs that still need a ticker lookup for a readable title. */
export function poolIdsNeedingTicker(
  txs: readonly { governance_action?: GovernanceAction | null }[],
): string[] {
  const needed = new Set<string>();
  for (const tx of txs) {
    const action = tx.governance_action;
    if (action?.kind !== "stake") continue;
    if (!action.poolId?.trim() || action.poolTicker?.trim()) continue;
    needed.add(action.poolId.trim());
  }
  return [...needed];
}

export function drepDescription(action: DrepAction, dRepId: string): string {
  switch (action) {
    case DrepAction.Register:
      return `DRep: register ${dRepId}`;
    case DrepAction.Update:
      return `DRep: update ${dRepId}`;
    case DrepAction.Retire:
      return `DRep: retire ${dRepId}`;
    default:
      return `DRep: ${dRepId}`;
  }
}

export function voteDescription(count: number, dRepId: string): string {
  return `Vote: ${plural(count, "proposal")} as ${dRepId}`;
}
