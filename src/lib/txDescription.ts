// The one-line `transactions.description` of a payout and of a manual payment.
// Shared by the build routes and the chain import, so a transaction rebuilt
// from the chain reads like the one the app would have built.

import { DrepAction, StakeAction } from "@/lib/constants";
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

export function stakeDescription(
  action: StakeAction,
  detail?: { poolId?: string | null; dRepId?: string | null },
): string {
  switch (action) {
    case StakeAction.Register:
      return "Stake: register";
    case StakeAction.RegisterAndDelegate:
      return `Stake: register and delegate${detail?.poolId ? ` to ${detail.poolId}` : ""}`;
    case StakeAction.Delegate:
      return `Stake: delegate${detail?.poolId ? ` to ${detail.poolId}` : ""}`;
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
