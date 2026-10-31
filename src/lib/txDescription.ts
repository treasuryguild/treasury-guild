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

/** Prefer CIP-119 givenName in titles; special targets get friendly labels. */
export function dRepLabel(detail?: {
  dRepId?: string | null;
  dRepName?: string | null;
}): string | null {
  const name = detail?.dRepName?.trim();
  if (name) return name;
  const id = detail?.dRepId?.trim();
  if (!id) return null;
  if (id === "always_abstain") return "Always abstain";
  if (id === "always_no_confidence") return "Always no confidence";
  return id;
}

export function stakeDescription(
  action: StakeAction,
  detail?: {
    poolId?: string | null;
    poolTicker?: string | null;
    dRepId?: string | null;
    dRepName?: string | null;
  },
): string {
  const pool = stakePoolLabel(detail);
  const drep = dRepLabel(detail);
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
      return `Stake: vote delegation${drep ? ` to ${drep}` : ""}`;
    default:
      return "Stake";
  }
}

export type StakeLabelMaps = {
  poolTickerById?: ReadonlyMap<string, string>;
  dRepNameById?: ReadonlyMap<string, string>;
};

/**
 * List / page title for a transaction. Stake rows prefer a known ticker
 * (`governance_action.poolTicker` or `poolTickerById`) over a baked-in pool id,
 * and a known DRep givenName over a baked-in dRep id.
 */
export function displayTxDescription(
  tx: { description: string | null; governance_action?: GovernanceAction | null },
  poolTickerByIdOrMaps?: ReadonlyMap<string, string> | StakeLabelMaps,
): string {
  const maps: StakeLabelMaps =
    poolTickerByIdOrMaps instanceof Map
      ? { poolTickerById: poolTickerByIdOrMaps }
      : (poolTickerByIdOrMaps ?? {});
  const action = tx.governance_action;
  if (action?.kind === "stake") {
    const fromPoolMap = action.poolId ? maps.poolTickerById?.get(action.poolId) : null;
    const fromDrepMap = action.dRepId ? maps.dRepNameById?.get(action.dRepId) : null;
    return stakeDescription(action.action, {
      poolId: action.poolId,
      poolTicker: action.poolTicker?.trim() || fromPoolMap || null,
      dRepId: action.dRepId,
      dRepName: action.dRepName?.trim() || fromDrepMap || null,
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

/** DRep ids on vote-delegation stake txs that still need a givenName lookup. */
export function dRepIdsNeedingName(
  txs: readonly { governance_action?: GovernanceAction | null }[],
): string[] {
  const needed = new Set<string>();
  for (const tx of txs) {
    const action = tx.governance_action;
    if (action?.kind !== "stake") continue;
    if (action.action !== StakeAction.VoteDelegation) continue;
    const id = action.dRepId?.trim();
    if (!id || action.dRepName?.trim()) continue;
    if (id === "always_abstain" || id === "always_no_confidence") continue;
    needed.add(id);
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
