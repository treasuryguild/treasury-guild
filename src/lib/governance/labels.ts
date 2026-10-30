// User-facing words for proposals: kinds, electorates, methods, choices, and
// one-line descriptions of a proposal's frozen rules. Client-safe.
import {
  DecisionMethod, Electorate, ProposalKind, Proposers, VoteChoice,
  type ProposalState, type StateTone,
} from "@/lib/constants";
import type { GovernanceCommunitySettingsRow, GovernanceSettingChangeRow, GovernanceSettingsRow } from "@/lib/db/types";
import { COMMUNITY_SETTINGS_KIND } from "@/lib/db/types";
import { plural, shortAddress } from "@/lib/format";
import { STORE_LABELS } from "@/lib/storage/locator";
import { isVotingOpen } from "./lifecycle";
import type { ProposalRules } from "./rules";

export const KIND_LABELS: Record<ProposalKind, string> = {
  [ProposalKind.Budget]: "Budget",
  [ProposalKind.Workgroup]: "New workgroup",
  [ProposalKind.Task]: "Task",
  [ProposalKind.Decision]: "Decision",
  [ProposalKind.Lead]: "Lead change",
};

export const ELECTORATE_LABELS: Record<Electorate, string> = {
  [Electorate.Members]: "All members",
  [Electorate.Admins]: "Admins",
  [Electorate.Managers]: "Admins and workgroup leads",
  [Electorate.Workgroup]: "People of the workgroups concerned",
  [Electorate.Contributors]: "Recently paid contributors",
  [Electorate.Leads]: "Current leads of the workgroup",
};

export const PROPOSER_LABELS: Record<Proposers, string> = {
  [Proposers.Members]: "Any member",
  [Proposers.Managers]: "Admins and leads of the workgroups concerned",
  [Proposers.Admins]: "Admins",
};

export const METHOD_LABELS: Record<DecisionMethod, string> = {
  [DecisionMethod.Consent]: "Consent",
  [DecisionMethod.Majority]: "Majority vote",
  [DecisionMethod.Lazy]: "Lazy consensus",
};

export const METHOD_HELP: Record<DecisionMethod, string> = {
  [DecisionMethod.Consent]:
    "Passes when nobody blocks and more members agree than disagree. A block needs a reason: use it for objections you cannot live with.",
  [DecisionMethod.Majority]: "Passes when yes votes exceed the threshold of yes + no. Abstentions count toward the quorum only.",
  [DecisionMethod.Lazy]: "Passes at the deadline unless enough members object, with a reason. No quorum.",
};

export const CHOICE_LABELS: Record<VoteChoice, string> = {
  [VoteChoice.Agree]: "Agree",
  [VoteChoice.Abstain]: "Abstain",
  [VoteChoice.Disagree]: "Disagree",
  [VoteChoice.Block]: "Block",
  [VoteChoice.Yes]: "Yes",
  [VoteChoice.No]: "No",
  [VoteChoice.Object]: "Object",
};

/** "Recently paid contributors (last 12 months), members for at least 30 days". */
export function describeElectorate(rules: Pick<ProposalRules, "electorate" | "activityMonths" | "minMemberDays">): string {
  const window = rules.electorate === Electorate.Workgroup || rules.electorate === Electorate.Contributors
    ? ` (last ${plural(rules.activityMonths, "month")})`
    : "";
  const age = rules.minMemberDays > 0 ? `, members for at least ${plural(rules.minMemberDays, "day")}` : "";
  return `${ELECTORATE_LABELS[rules.electorate]}${window}${age}`;
}

/** "Consent, quorum 25%" / "Majority vote above 50%, quorum 20%" / "Lazy consensus, 1 objection rejects". */
export function describeMethod(rules: Pick<ProposalRules, "method" | "quorumPct" | "thresholdPct" | "lazyObjections">): string {
  if (rules.method === DecisionMethod.Lazy) {
    return `${METHOD_LABELS.lazy}, ${plural(rules.lazyObjections, "objection")} ${rules.lazyObjections === 1 ? "rejects" : "reject"}`;
  }
  const threshold = rules.method === DecisionMethod.Majority ? ` above ${rules.thresholdPct}%` : "";
  return `${METHOD_LABELS[rules.method]}${threshold}, quorum ${rules.quorumPct}%`;
}

/** "2 days" / "36 hours" / "none". */
export function describeHours(hours: number): string {
  if (hours === 0) return "none";
  return hours % 24 === 0 ? plural(hours / 24, "day") : plural(hours, "hour");
}

/**
 * How `rules` differ from the community default, one line each
 * ("Voting: 2 days, community default is 5 days"). Empty when they match.
 * A number the method does not use (a quorum under lazy consensus) is left out.
 */
export function describeRulesChanges(rules: ProposalRules, baseline: ProposalRules): string[] {
  const lines: string[] = [];
  const push = (label: string, value: string, was: string) => {
    if (value !== was) lines.push(`${label}: ${value}, community default is ${was}`);
  };
  push("Who votes", describeElectorate(rules), describeElectorate(baseline));
  push("Decided by", describeMethod(rules), describeMethod(baseline));
  push("Discussion", describeHours(rules.discussionHours), describeHours(baseline.discussionHours));
  push("Voting", describeHours(rules.votingHours), describeHours(baseline.votingHours));
  if (rules.hideResults !== baseline.hideResults) {
    lines.push(rules.hideResults
      ? "Results: hidden until voting closes, community default is shown while voting runs"
      : "Results: shown while voting runs, community default is hidden until voting closes");
  }
  if (rules.recuseBeneficiaries !== baseline.recuseBeneficiaries) {
    lines.push(rules.recuseBeneficiaries
      ? "Those who gain from it are recused, which the community default does not do"
      : "Those who gain from it may vote, which the community default recuses");
  }
  return lines;
}

/** "in 2 days" / "3 hours ago" / "in 12 minutes": the largest whole unit, rounded down. */
export function relativeTime(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000);
  const span = minutes >= 2 * 24 * 60 ? plural(Math.floor(minutes / (24 * 60)), "day")
    : minutes >= 120 ? plural(Math.floor(minutes / 60), "hour")
      : minutes >= 1 ? plural(minutes, "minute")
        : "a moment";
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

/** Where a proposal stands in time, for lists and headers. */
export function proposalTiming(
  p: { state: ProposalState; voting_starts_at: string; closes_at: string | null; closed_at: string | null },
  now: number,
): string {
  if (p.state === "discussion") {
    return Date.parse(p.voting_starts_at) > now ? `Voting opens ${relativeTime(p.voting_starts_at, now)}` : "Voting opens shortly";
  }
  if (p.state === "voting" && p.closes_at) {
    return Date.parse(p.closes_at) > now ? `Voting closes ${relativeTime(p.closes_at, now)}` : "Voting closed, counting shortly";
  }
  return p.closed_at ? `Closed ${relativeTime(p.closed_at, now)}` : "Closed";
}

/** List-row badge for the caller's own ballot: omit when ineligible or still in discussion. */
export function proposalVoteIndicator(
  p: { state: ProposalState; closes_at: string | null },
  now: number,
  seat: { recused: boolean } | undefined,
  choice: VoteChoice | undefined,
): { label: string; tone: StateTone } | null {
  if (choice) return { label: `Voted · ${CHOICE_LABELS[choice]}`, tone: "green" };
  if (isVotingOpen(p, now) && seat && !seat.recused) return { label: "Not voted", tone: "yellow" };
  return null;
}

/** A member's display name: their handle, else the shortened wallet. */
export function voterName(wallet: string, handle: string | null | undefined): string {
  return handle?.trim() || shortAddress(wallet);
}

export const SPEND_CHECK_LABELS: Record<string, string> = { warn: "warn", refuse: "refuse" };

/**
 * "Budget settings changed by X, turned on" / "Records and checks set by X:
 * documents published to IPFS, failed budget checks refuse": one line per
 * entry of the settings log, whichever table it came from.
 */
export function describeSettingChange(change: GovernanceSettingChangeRow, actor: string): string {
  const verb = change.before_value ? "changed" : "set";
  if (change.kind === COMMUNITY_SETTINGS_KIND) {
    const before = change.before_value as GovernanceCommunitySettingsRow | null;
    const after = change.after_value as GovernanceCommunitySettingsRow;
    const details: string[] = [];
    if ((before?.document_store ?? null) !== after.document_store) {
      details.push(after.document_store ? `documents published to ${STORE_LABELS[after.document_store]}` : "publication off");
    } else if (
      after.document_store === "github"
      && (before?.document_archive_repo_id ?? null) !== (after.document_archive_repo_id ?? null)
    ) {
      details.push(`GitHub archive ${after.document_archive_full_name ?? after.document_archive_repo_id}`);
    }
    if ((before?.spend_check ?? "warn") !== after.spend_check) {
      details.push(`failed budget checks ${SPEND_CHECK_LABELS[after.spend_check] ?? after.spend_check}`);
    }
    return `Records and checks ${verb} by ${actor}${details.length ? `: ${details.join(", ")}` : ""}`;
  }
  const before = change.before_value as GovernanceSettingsRow | null;
  const after = change.after_value as GovernanceSettingsRow;
  const toggled = (before?.enabled ?? false) !== after.enabled ? (after.enabled ? ", turned on" : ", turned off") : "";
  return `${KIND_LABELS[change.kind]} settings ${verb} by ${actor}${toggled}`;
}
