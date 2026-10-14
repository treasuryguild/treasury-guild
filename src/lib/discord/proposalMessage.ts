// The Discord messages that announce a proposal: up for discussion, voting
// open, a day left, the result. Pure and client-safe. Messages carry the
// proposal's title, kind, timing, rules and counts, never a member's name or
// wallet (as payout messages carry none).
import { ExecutionState, ProposalState } from "@/lib/constants";
import type { ProposalRow } from "@/lib/db/types";
import { truncate } from "@/lib/format";
import { describeElectorate, describeMethod, KIND_LABELS } from "@/lib/governance/labels";
import { OUTCOME_TEXT, type OutcomeReason } from "@/lib/governance/tally";
import { USERNAME, type DiscordEmbedField, type DiscordWebhookPayload } from "./payoutMessage";

export type ProposalMilestone = "discussion" | "voting" | "reminder" | "closed";

const ORDER: readonly ProposalMilestone[] = ["discussion", "voting", "reminder", "closed"];

/** "A day left" is posted this long before voting closes, when voting runs longer than that. */
export const REMINDER_BEFORE_MS = 24 * 60 * 60 * 1000;

type Timing = Pick<ProposalRow, "state" | "closes_at" | "execution_state" | "rules">;

/** Where the proposal stands now, as a milestone (a passed one before it was carried out included). */
export function currentMilestone(p: Timing, now: number): ProposalMilestone {
  if (p.state === ProposalState.Discussion) return "discussion";
  if (p.state === ProposalState.Voting) {
    const closesSoon = !!p.closes_at && Date.parse(p.closes_at) - now <= REMINDER_BEFORE_MS;
    return closesSoon && p.rules.votingHours * 3_600_000 > REMINDER_BEFORE_MS ? "reminder" : "voting";
  }
  return "closed";
}

/**
 * The milestone to announce now, or null: the current one when it comes after
 * the last posted. Earlier milestones skipped between two sweeps are never
 * posted late. A passed proposal is announced once it was carried out (or failed).
 */
export function dueMilestone(p: Timing & Pick<ProposalRow, "discord_milestone">, now: number): ProposalMilestone | null {
  if (p.state === ProposalState.Passed && p.execution_state === ExecutionState.Pending) return null;
  const target = currentMilestone(p, now);
  const last = p.discord_milestone ? ORDER.indexOf(p.discord_milestone) : -1;
  return ORDER.indexOf(target) > last ? target : null;
}

const COLORS = {
  neutral: 0x6366f1,
  green: 0x10b981,
  red: 0xef4444,
  amber: 0xf59e0b,
  grey: 0x71717a,
} as const;

const RESULT: Record<string, { title: string; color: number }> = {
  [ProposalState.Passed]: { title: "✅ Passed", color: COLORS.green },
  [ProposalState.Rejected]: { title: "❌ Rejected", color: COLORS.red },
  [ProposalState.Expired]: { title: "⌛ No quorum", color: COLORS.amber },
  [ProposalState.Withdrawn]: { title: "↩️ Withdrawn", color: COLORS.grey },
  [ProposalState.Cancelled]: { title: "🚫 Cancelled", color: COLORS.grey },
};

/** Discord renders `<t:unix:R>` as "in 2 days" in each reader's own clock. */
function discordTime(iso: string | null): string {
  return iso ? `<t:${Math.floor(Date.parse(iso) / 1000)}:R>` : "—";
}

function turnout(p: Pick<ProposalRow, "ballots_cast" | "electorate_size">): string {
  return `${p.ballots_cast} of ${p.electorate_size ?? 0} voted`;
}

export type AnnouncedProposal = Pick<ProposalRow,
  | "number" | "title" | "kind" | "state" | "rules" | "voting_starts_at" | "closes_at" | "electorate_size"
  | "ballots_cast" | "tally" | "outcome_reason" | "execution_state" | "execution_error" | "end_reason">;

export function buildProposalEmbed(input: {
  communityName: string;
  proposal: AnnouncedProposal;
  milestone: ProposalMilestone;
  url: string;
}): DiscordWebhookPayload {
  const { proposal: p, milestone } = input;
  const heading = `Proposal #${p.number} · ${KIND_LABELS[p.kind]}`;
  const fields: DiscordEmbedField[] = [];
  let title: string;
  let color: number = COLORS.neutral;

  if (milestone === "discussion") {
    title = `💬 Up for discussion · ${heading}`;
    fields.push({ name: "Voting opens", value: discordTime(p.voting_starts_at), inline: true });
  } else if (milestone === "voting") {
    title = `🗳️ Voting open · ${heading}`;
    fields.push({ name: "Voting closes", value: discordTime(p.closes_at), inline: true });
    fields.push({ name: "Voters", value: String(p.electorate_size ?? 0), inline: true });
  } else if (milestone === "reminder") {
    title = `⏳ Voting closes soon · ${heading}`;
    color = COLORS.amber;
    fields.push({ name: "Voting closes", value: discordTime(p.closes_at), inline: true });
    fields.push({ name: "Turnout", value: turnout(p), inline: true });
  } else {
    const result = RESULT[p.state] ?? { title: p.state, color: COLORS.grey };
    title = `${result.title} · ${heading}`;
    color = result.color;
    if (p.electorate_size) fields.push({ name: "Turnout", value: turnout(p), inline: true });
    if (p.tally && p.ballots_cast > 0) {
      const counts = Object.entries(p.tally.counts).map(([choice, n]) => `${choice} ${n}`).join(" · ");
      fields.push({ name: "Ballots", value: counts, inline: true });
    }
    if (p.outcome_reason && p.state !== ProposalState.Passed) {
      fields.push({ name: "Why", value: OUTCOME_TEXT[p.outcome_reason as OutcomeReason] ?? p.outcome_reason });
    }
    if (p.end_reason) fields.push({ name: "Reason", value: truncate(p.end_reason, 500) });
    if (p.execution_state === ExecutionState.Applied) fields.push({ name: "Carried out", value: "Applied in Treasury Guild" });
    if (p.execution_state === ExecutionState.Failed) {
      fields.push({ name: "Carried out", value: truncate(`Could not be applied: ${p.execution_error ?? "error"}`, 500) });
    }
  }
  if (milestone === "discussion" || milestone === "voting") {
    fields.push({ name: "Decided by", value: describeMethod(p.rules) });
    fields.push({ name: "Who votes", value: describeElectorate(p.rules) });
  }

  return {
    username: USERNAME,
    embeds: [{
      title: truncate(title, 256),
      url: input.url,
      description: `**${truncate(p.title, 300)}**\n${input.communityName}${milestone === "closed" ? "" : ` · vote with your wallet in Treasury Guild`}`,
      color,
      fields,
    }],
  };
}

export function buildGovernanceConnectedEmbed(communityName: string): DiscordWebhookPayload {
  return {
    username: USERNAME,
    embeds: [{
      title: "🔗 Treasury Guild connected",
      description: `New proposals of **${communityName}** will be announced in this channel: when they are up for discussion, when voting opens, a day before it closes, and the result.`,
      color: COLORS.neutral,
    }],
  };
}
