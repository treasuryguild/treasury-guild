// Classify an on-chain treasury spend the app has no `transactions` row for,
// from Koios certificates / metadata / withdrawals / votes. Pure and
// client-safe: poll stores the result on `external_txs.activity`, and the
// Treasury list titles it before falling back to "Outgoing transfer".

import { ANCHOR_METADATA_LABEL, parseAnchorMetadata } from "@/lib/cardano/anchorMetadata";
import {
  METADATA_LABEL_1854,
  parseLabel1854Metadata,
} from "@/lib/cardano/cip146Registration";
import { DrepAction, StakeAction, TxKind } from "@/lib/constants";
import type { GovernanceAction } from "@/lib/db/types";
import { isRecord } from "@/lib/guards";
import {
  anchorDescription,
  drepDescription,
  registrationDescription,
  stakeDescription,
  voteDescription,
} from "@/lib/txDescription";

/** Stored on `external_txs.activity` (migration 0086). */
export type ExternalActivity =
  | { kind: typeof TxKind.Registration }
  | { kind: typeof TxKind.Anchor; proposalNumbers?: number[] }
  | {
      kind: typeof TxKind.Stake;
      action: StakeAction;
      poolId?: string | null;
      poolTicker?: string | null;
      dRepId?: string | null;
      dRepName?: string | null;
    }
  | { kind: typeof TxKind.Drep; action: DrepAction; dRepId: string }
  | { kind: typeof TxKind.Vote; dRepId: string; voteCount: number };

/** Koios `/tx_info` certificate entry (`_certs: true`). */
export interface KoiosCertificate {
  index?: number | null;
  type?: string | null;
  info?: Record<string, unknown> | null;
}

/** Koios `/tx_info` withdrawal entry (`_withdrawals: true`). */
export interface KoiosWithdrawal {
  amount?: string | null;
  stake_addr?: string | null;
}

/** Koios `/tx_info` voting_procedures entry (`_governance: true`). */
export interface KoiosVotingProcedure {
  voter?: string | null;
  vote?: string | null;
  proposal_tx_hash?: string | null;
}

export interface ClassifyExternalInput {
  metadata?: Record<string, unknown> | null;
  certificates?: readonly KoiosCertificate[] | null;
  withdrawals?: readonly KoiosWithdrawal[] | null;
  voting_procedures?: readonly KoiosVotingProcedure[] | null;
}

/** Kinds that are not opaque budget spends: titled + kind badge, never "Built outside". */
export function isRecognizedExternalActivity(
  activity: ExternalActivity | null | undefined,
): activity is ExternalActivity {
  if (!activity) return false;
  return (
    activity.kind === TxKind.Registration ||
    activity.kind === TxKind.Anchor ||
    activity.kind === TxKind.Stake ||
    activity.kind === TxKind.Drep ||
    activity.kind === TxKind.Vote
  );
}

/** Narrow unknown jsonb from the database into ExternalActivity. */
export function parseExternalActivity(value: unknown): ExternalActivity | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case TxKind.Registration:
      return { kind: TxKind.Registration };
    case TxKind.Anchor: {
      const nums = Array.isArray(value.proposalNumbers)
        ? value.proposalNumbers.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
        : undefined;
      return nums && nums.length > 0
        ? { kind: TxKind.Anchor, proposalNumbers: nums }
        : { kind: TxKind.Anchor };
    }
    case TxKind.Stake: {
      if (typeof value.action !== "string") return null;
      if (!Object.values(StakeAction).includes(value.action as StakeAction)) return null;
      return {
        kind: TxKind.Stake,
        action: value.action as StakeAction,
        poolId: stringOrNull(value.poolId),
        poolTicker: stringOrNull(value.poolTicker),
        dRepId: stringOrNull(value.dRepId),
        dRepName: stringOrNull(value.dRepName),
      };
    }
    case TxKind.Drep: {
      if (typeof value.action !== "string" || typeof value.dRepId !== "string") return null;
      if (!Object.values(DrepAction).includes(value.action as DrepAction)) return null;
      return { kind: TxKind.Drep, action: value.action as DrepAction, dRepId: value.dRepId };
    }
    case TxKind.Vote: {
      if (typeof value.dRepId !== "string") return null;
      const voteCount = typeof value.voteCount === "number" && value.voteCount > 0 ? value.voteCount : 1;
      return { kind: TxKind.Vote, dRepId: value.dRepId, voteCount };
    }
    default:
      return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function infoString(info: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!info) return null;
  for (const key of keys) {
    const v = info[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Classify from Koios tx_info fields. Label 190001 is ignored here (handled via
 * `payout_meta` / chain import). Returns null when nothing recognizable.
 */
export function classifyExternalActivity(input: ClassifyExternalInput): ExternalActivity | null {
  const meta = input.metadata ?? null;

  if (meta) {
    const registration = parseLabel1854Metadata(meta[METADATA_LABEL_1854] ?? meta["1854"]);
    if (registration) return { kind: TxKind.Registration };

    const anchorRaw = meta[ANCHOR_METADATA_LABEL] ?? meta["190002"];
    const anchor = parseAnchorMetadata(anchorRaw);
    if (anchor) {
      const proposalNumbers = [...new Set(anchor.a.map((e) => e[0]))].sort((a, b) => a - b);
      return { kind: TxKind.Anchor, proposalNumbers };
    }
    // Phase-0 test record still marks the label as an anchor-shaped spend.
    if (isRecord(anchorRaw) && anchorRaw.src === "treasury-guild" && anchorRaw.test === 1) {
      return { kind: TxKind.Anchor };
    }
  }

  const certs = [...(input.certificates ?? [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  const fromCerts = classifyCertificates(certs);
  if (fromCerts) return fromCerts;

  const withdrawals = input.withdrawals ?? [];
  if (withdrawals.some((w) => typeof w.amount === "string" && BigInt(w.amount || "0") > 0n)) {
    return { kind: TxKind.Stake, action: StakeAction.Withdraw };
  }

  const votes = input.voting_procedures ?? [];
  if (votes.length > 0) {
    const dRepId =
      votes.map((v) => (typeof v.voter === "string" ? v.voter.trim() : "")).find((id) => id.length > 0) ||
      "DRep";
    return { kind: TxKind.Vote, dRepId, voteCount: votes.length };
  }

  return null;
}

function classifyCertificates(certs: readonly KoiosCertificate[]): ExternalActivity | null {
  if (certs.length === 0) return null;

  const types = new Set(certs.map((c) => normalizeCertType(c.type)));

  // DRep certificate wins when present (a wallet rarely mixes these with stake).
  for (const cert of certs) {
    const type = normalizeCertType(cert.type);
    const dRepId = infoString(cert.info ?? undefined, "drep_id");
    if (!dRepId) continue;
    if (type === "drep_registration") {
      return { kind: TxKind.Drep, action: DrepAction.Register, dRepId };
    }
    if (type === "drep_update") {
      return { kind: TxKind.Drep, action: DrepAction.Update, dRepId };
    }
    if (type === "drep_retire") {
      return { kind: TxKind.Drep, action: DrepAction.Retire, dRepId };
    }
  }

  const hasRegister = types.has("stake_registration");
  const hasDelegate = types.has("pool_delegation") || types.has("delegation");
  const hasVoteDeleg = types.has("vote_delegation");
  const hasDeregister = types.has("stake_deregistration");

  if (hasVoteDeleg) {
    const voteCert = certs.find((c) => normalizeCertType(c.type) === "vote_delegation");
    return {
      kind: TxKind.Stake,
      action: StakeAction.VoteDelegation,
      dRepId: infoString(voteCert?.info ?? undefined, "drep_id"),
    };
  }

  if (hasRegister && hasDelegate) {
    const deleg = certs.find((c) => {
      const t = normalizeCertType(c.type);
      return t === "pool_delegation" || t === "delegation";
    });
    return {
      kind: TxKind.Stake,
      action: StakeAction.RegisterAndDelegate,
      poolId: infoString(deleg?.info ?? undefined, "pool_id_bech32", "pool_id_hex", "pool"),
    };
  }

  if (hasRegister) {
    return { kind: TxKind.Stake, action: StakeAction.Register };
  }

  if (hasDelegate) {
    const deleg = certs.find((c) => {
      const t = normalizeCertType(c.type);
      return t === "pool_delegation" || t === "delegation";
    });
    return {
      kind: TxKind.Stake,
      action: StakeAction.Delegate,
      poolId: infoString(deleg?.info ?? undefined, "pool_id_bech32", "pool_id_hex", "pool"),
    };
  }

  if (hasDeregister) {
    return { kind: TxKind.Stake, action: StakeAction.Deregister };
  }

  return null;
}

function normalizeCertType(type: string | null | undefined): string {
  return (type ?? "").trim().toLowerCase();
}

/** Title line matching an app-built transaction of the same kind. */
export function externalActivityTitle(activity: ExternalActivity): string {
  switch (activity.kind) {
    case TxKind.Registration:
      return registrationDescription();
    case TxKind.Anchor:
      return activity.proposalNumbers && activity.proposalNumbers.length > 0
        ? anchorDescription(activity.proposalNumbers)
        : "Anchors on-chain";
    case TxKind.Stake:
      return stakeDescription(activity.action, {
        poolId: activity.poolId,
        poolTicker: activity.poolTicker,
        dRepId: activity.dRepId,
        dRepName: activity.dRepName,
      });
    case TxKind.Drep:
      return drepDescription(activity.action, activity.dRepId);
    case TxKind.Vote:
      return voteDescription(activity.voteCount, activity.dRepId);
  }
}

/** Short detail line under the title (replaces "to N addresses" for classified rows). */
export function externalActivityDetail(activity: ExternalActivity): string {
  switch (activity.kind) {
    case TxKind.Registration:
      return "CIP-0146 registration";
    case TxKind.Anchor:
      return "On-chain anchor";
    case TxKind.Stake:
      return "Stake certificate";
    case TxKind.Drep:
      return "DRep certificate";
    case TxKind.Vote:
      return "Governance vote";
  }
}

/**
 * Shape the classifier result for `GovernanceActionCard`. Registration and
 * anchor kinds have their own cards from CBOR; those return null here.
 * Vote entries are count-only (no per-proposal detail on `external_txs`).
 */
export function governanceActionFromActivity(
  activity: ExternalActivity | null | undefined,
): GovernanceAction | null {
  if (!activity) return null;
  switch (activity.kind) {
    case TxKind.Stake:
      return {
        kind: "stake",
        action: activity.action,
        poolId: activity.poolId ?? null,
        poolTicker: activity.poolTicker ?? null,
        dRepId: activity.dRepId ?? null,
        dRepName: activity.dRepName ?? null,
        rewards: null,
      };
    case TxKind.Drep:
      return { kind: "drep", action: activity.action, dRepId: activity.dRepId };
    case TxKind.Vote: {
      const n = Math.max(1, activity.voteCount);
      return {
        kind: "vote",
        dRepId: activity.dRepId,
        votes: Array.from({ length: n }, (_, certIndex) => ({
          txHash: "",
          certIndex,
          voteKind: "Abstain" as const,
        })),
      };
    }
    default:
      return null;
  }
}
