// Governance rules: each proposal kind's defaults, the settings row ↔ app
// shape, and the rules frozen onto a proposal when it is made (the server
// hashes them; every ballot signs the hash). Client-safe.
import { DecisionMethod, Electorate, ProposalKind, Proposers } from "@/lib/constants";
import type { DocumentStoreName, GovernanceCommunitySettingsRow, GovernanceSettingsRow } from "@/lib/db/types";

/** One kind's settings as the app edits them (governance_settings, camelCased). */
export interface GovernanceSettings {
  /** budget: budget consent (direct saves refused); decision: members may open polls. */
  enabled: boolean;
  proposers: Proposers;
  electorate: Electorate;
  /** Look-back of the workgroup and contributors electorates. */
  activityMonths: number;
  /** Members who joined fewer days than this before a proposal was made do not vote on it. */
  minMemberDays: number;
  method: DecisionMethod;
  quorumPct: number;
  /** Majority: the share of yes among yes + no that must be exceeded. */
  thresholdPct: number;
  /** Lazy consensus: this many objections reject. */
  lazyObjections: number;
  /** Lazy consensus above this amount (lovelace) is decided by `escalateMethod`; null = no cap. */
  lazyCapLovelace: string | null;
  escalateMethod: DecisionMethod | null;
  discussionHours: number;
  votingHours: number;
  /** Ballots are hidden until voting closes; only turnout shows. */
  hideResults: boolean;
  /** Those who gain from a proposal (a budgeted workgroup's leads) do not vote on it. */
  recuseBeneficiaries: boolean;
}

/** What a proposal is decided by, frozen when it is made (proposals.rules). */
export interface ProposalRules {
  method: DecisionMethod;
  electorate: Electorate;
  activityMonths: number;
  minMemberDays: number;
  quorumPct: number;
  thresholdPct: number;
  lazyObjections: number;
  discussionHours: number;
  votingHours: number;
  hideResults: boolean;
  recuseBeneficiaries: boolean;
}

/** The kinds a community can turn on, in the order the settings page shows them. */
export const LIVE_PROPOSAL_KINDS: readonly ProposalKind[] = [
  ProposalKind.Budget, ProposalKind.Workgroup, ProposalKind.Task, ProposalKind.Decision,
];

const BASE: GovernanceSettings = {
  enabled: false,
  proposers: Proposers.Members,
  electorate: Electorate.Members,
  activityMonths: 12,
  minMemberDays: 0,
  method: DecisionMethod.Majority,
  quorumPct: 20,
  thresholdPct: 50,
  lazyObjections: 1,
  lazyCapLovelace: null,
  escalateMethod: null,
  discussionHours: 48,
  votingHours: 120,
  hideResults: true,
  recuseBeneficiaries: false,
};

/** Defaults per kind, used until an admin saves the kind's settings. */
export const DEFAULT_SETTINGS: Record<ProposalKind, GovernanceSettings> = {
  [ProposalKind.Budget]: {
    ...BASE, proposers: Proposers.Managers, method: DecisionMethod.Consent, quorumPct: 25,
    discussionHours: 24, votingHours: 72,
  },
  [ProposalKind.Workgroup]: BASE,
  [ProposalKind.Task]: {
    ...BASE, electorate: Electorate.Workgroup, method: DecisionMethod.Lazy, escalateMethod: DecisionMethod.Majority,
    discussionHours: 0, votingHours: 72,
  },
  [ProposalKind.Decision]: BASE,
};

export function settingsFromRow(row: GovernanceSettingsRow | null | undefined, kind: ProposalKind): GovernanceSettings {
  if (!row) return DEFAULT_SETTINGS[kind];
  return {
    enabled: row.enabled,
    proposers: row.proposers,
    electorate: row.electorate,
    activityMonths: row.activity_months,
    minMemberDays: row.min_member_days,
    method: row.method,
    quorumPct: row.quorum_pct,
    thresholdPct: row.threshold_pct,
    lazyObjections: row.lazy_objections,
    lazyCapLovelace: row.lazy_cap_lovelace === null ? null : String(row.lazy_cap_lovelace),
    escalateMethod: row.escalate_method,
    discussionHours: row.discussion_hours,
    votingHours: row.voting_hours,
    hideResults: row.hide_results,
    recuseBeneficiaries: row.recuse_beneficiaries,
  };
}

/** The settings columns save_governance_settings writes. */
export type GovernanceSettingsColumns = Omit<GovernanceSettingsRow, "community_id" | "kind" | "updated_by" | "updated_at">;

export function settingsToRow(settings: GovernanceSettings): GovernanceSettingsColumns {
  return {
    enabled: settings.enabled,
    proposers: settings.proposers,
    electorate: settings.electorate,
    activity_months: settings.activityMonths,
    min_member_days: settings.minMemberDays,
    method: settings.method,
    quorum_pct: settings.quorumPct,
    threshold_pct: settings.thresholdPct,
    lazy_objections: settings.lazyObjections,
    lazy_cap_lovelace: settings.lazyCapLovelace,
    escalate_method: settings.escalateMethod,
    discussion_hours: settings.discussionHours,
    voting_hours: settings.votingHours,
    hide_results: settings.hideResults,
    recuse_beneficiaries: settings.recuseBeneficiaries,
  };
}

/** What a spend that fails the budget check does (governance_community_settings.spend_check). */
export const SpendCheckMode = {
  /** The build succeeds; the problems are stored on the transaction for the signers. */
  Warn: "warn",
  /** The build fails with the problems. */
  Refuse: "refuse",
} as const;
export type SpendCheckMode = (typeof SpendCheckMode)[keyof typeof SpendCheckMode];

/** The community-level governance settings (0059), one row per community; a missing row is these defaults. */
export interface GovernanceCommunitySettings {
  /** Where new frozen tally documents are published; null keeps them in the database only. */
  documentStore: DocumentStoreName | null;
  /** When the current store was chosen: only documents frozen from then on are published. */
  documentStoreSince: string | null;
  spendCheck: SpendCheckMode;
}

export const DEFAULT_COMMUNITY_SETTINGS: GovernanceCommunitySettings = {
  documentStore: null, documentStoreSince: null, spendCheck: SpendCheckMode.Warn,
};

export function communitySettingsFromRow(row: GovernanceCommunitySettingsRow | null | undefined): GovernanceCommunitySettings {
  if (!row) return DEFAULT_COMMUNITY_SETTINGS;
  return { documentStore: row.document_store, documentStoreSince: row.document_store_since, spendCheck: row.spend_check };
}

/**
 * The rules a new proposal is frozen with. `escalate` decides it by the
 * settings' escalation method instead of lazy consensus (an amount above the cap).
 */
export function rulesFor(settings: GovernanceSettings, opts: { escalate?: boolean } = {}): ProposalRules {
  const method = opts.escalate && settings.method === DecisionMethod.Lazy && settings.escalateMethod
    ? settings.escalateMethod
    : settings.method;
  return {
    method,
    electorate: settings.electorate,
    activityMonths: settings.activityMonths,
    minMemberDays: settings.minMemberDays,
    quorumPct: settings.quorumPct,
    thresholdPct: settings.thresholdPct,
    lazyObjections: settings.lazyObjections,
    discussionHours: settings.discussionHours,
    votingHours: settings.votingHours,
    hideResults: settings.hideResults,
    recuseBeneficiaries: settings.recuseBeneficiaries,
  };
}

/**
 * Deterministic JSON for hashing: object keys sorted at every level, arrays
 * in order, no whitespace. `undefined` members are dropped, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
