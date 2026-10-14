import { describe, expect, it } from "vitest";
import type { ProposalRules } from "@/lib/governance/rules";
import { buildGovernanceConnectedEmbed, buildProposalEmbed, currentMilestone, dueMilestone, type AnnouncedProposal } from "./proposalMessage";

const now = Date.parse("2026-09-29T12:00:00Z");
const rules = {
  method: "majority", electorate: "members", activityMonths: 12, minMemberDays: 0, quorumPct: 20, thresholdPct: 50,
  lazyObjections: 1, discussionHours: 48, votingHours: 120, hideResults: true, recuseBeneficiaries: false,
} as ProposalRules;
const inDays = (d: number) => new Date(now + d * 86_400_000).toISOString();
const base = { state: "voting", closes_at: inDays(3), execution_state: null, rules, discord_milestone: null } as const;

describe("milestones", () => {
  it("follows the proposal and posts each milestone once", () => {
    expect(dueMilestone({ ...base, state: "discussion" }, now)).toBe("discussion");
    expect(dueMilestone({ ...base, state: "discussion", discord_milestone: "discussion" }, now)).toBeNull();
    expect(dueMilestone({ ...base, discord_milestone: "discussion" }, now)).toBe("voting");
    expect(dueMilestone({ ...base, discord_milestone: "voting" }, now)).toBeNull();
    expect(dueMilestone({ ...base, closes_at: inDays(0.5), discord_milestone: "voting" }, now)).toBe("reminder");
    expect(dueMilestone({ ...base, state: "rejected", discord_milestone: "voting" }, now)).toBe("closed");
    expect(dueMilestone({ ...base, state: "rejected", discord_milestone: "closed" }, now)).toBeNull();
  });

  it("skips a missed milestone instead of posting it late", () => {
    // Voting opened and nearly ended between two sweeps: only the reminder goes out.
    expect(dueMilestone({ ...base, closes_at: inDays(0.5) }, now)).toBe("reminder");
  });

  it("has no reminder for a vote of a day or less", () => {
    expect(currentMilestone({ ...base, closes_at: inDays(0.5), rules: { ...rules, votingHours: 24 } }, now)).toBe("voting");
  });

  it("waits for a passed proposal to be carried out", () => {
    expect(dueMilestone({ ...base, state: "passed", execution_state: "pending" }, now)).toBeNull();
    expect(dueMilestone({ ...base, state: "passed", execution_state: "applied" }, now)).toBe("closed");
  });
});

describe("buildProposalEmbed", () => {
  const proposal: AnnouncedProposal = {
    number: 7, title: "Adopt a code of conduct", kind: "decision", state: "voting", rules,
    voting_starts_at: inDays(-1), closes_at: inDays(3), electorate_size: 12, ballots_cast: 4, tally: null,
    outcome_reason: null, execution_state: null, execution_error: null, end_reason: null,
  };

  it("announces voting with its deadline and rules, and no names", () => {
    const { embeds: [embed] } = buildProposalEmbed({ communityName: "Guild", proposal, milestone: "voting", url: "https://app/p/7" });
    expect(embed!.title).toBe("🗳️ Voting open · Proposal #7 · Decision");
    expect(embed!.url).toBe("https://app/p/7");
    expect(embed!.fields).toEqual(expect.arrayContaining([
      { name: "Voting closes", value: `<t:${Math.floor(Date.parse(inDays(3)) / 1000)}:R>`, inline: true },
      { name: "Voters", value: "12", inline: true },
      { name: "Decided by", value: "Majority vote above 50%, quorum 20%" },
    ]));
    expect(JSON.stringify(embed)).not.toMatch(/addr/);
  });

  it("reports a result with counts, why it failed, and whether it was applied", () => {
    const rejected = buildProposalEmbed({ communityName: "Guild", url: "u", milestone: "closed", proposal: {
      ...proposal, state: "rejected", outcome_reason: "threshold",
      tally: { counts: { yes: 2, no: 2 }, ballots: 4, electorate: 12, quorumMet: true, state: "rejected", reason: "threshold" },
    } }).embeds[0]!;
    expect(rejected.title).toBe("❌ Rejected · Proposal #7 · Decision");
    expect(rejected.fields).toEqual(expect.arrayContaining([
      { name: "Ballots", value: "yes 2 · no 2", inline: true },
      { name: "Why", value: "Not enough yes votes" },
    ]));
    const failed = buildProposalEmbed({ communityName: "Guild", url: "u", milestone: "closed", proposal: {
      ...proposal, kind: "budget", state: "passed", execution_state: "failed", execution_error: "Budgets changed",
    } }).embeds[0]!;
    expect(failed.fields).toContainEqual({ name: "Carried out", value: "Could not be applied: Budgets changed" });
  });
});

describe("buildGovernanceConnectedEmbed", () => {
  it("confirms the connection in one embed, naming the community", () => {
    const payload = buildGovernanceConnectedEmbed("Signius");
    expect(payload.username).toBe("Treasury Guild");
    expect(payload.embeds).toHaveLength(1);
    const [embed] = payload.embeds;
    expect(embed!.title).toBe("🔗 Treasury Guild connected");
    expect(embed!.description).toContain("**Signius**");
    expect(embed!.color).toBe(0x6366f1);
    // A confirmation, not an announcement: no link, no fields.
    expect(embed!.url).toBeUndefined();
    expect(embed!.fields).toBeUndefined();
  });

  it("says which four moments of a proposal will be announced", () => {
    const description = buildGovernanceConnectedEmbed("Signius").embeds[0]!.description!;
    expect(description).toMatch(/up for discussion/);
    expect(description).toMatch(/voting opens/);
    expect(description).toMatch(/a day before it closes/);
    expect(description).toMatch(/the result/);
    expect(description).toMatch(/proposals/i);
    expect(description).not.toMatch(/payout/i);
  });

  it("uses the name as given and nothing else about the community", () => {
    const a = buildGovernanceConnectedEmbed("Alpha").embeds[0]!;
    const b = buildGovernanceConnectedEmbed("Beta").embeds[0]!;
    expect(a.description!.replace("Alpha", "Beta")).toBe(b.description);
    expect(a.title).toBe(b.title);
  });

  it("uses the neutral colour of a discussion announcement", () => {
    const proposal: AnnouncedProposal = {
      number: 1, title: "Adopt a code of conduct", kind: "decision", state: "discussion", rules,
      voting_starts_at: inDays(2), closes_at: null, electorate_size: null, ballots_cast: 0, tally: null,
      outcome_reason: null, execution_state: null, execution_error: null, end_reason: null,
    };
    const announced = buildProposalEmbed({ communityName: "Signius", proposal, milestone: "discussion", url: "https://vault.test/p" });
    expect(buildGovernanceConnectedEmbed("Signius").embeds[0]!.color).toBe(announced.embeds[0]!.color);
    expect(buildGovernanceConnectedEmbed("Signius").username).toBe(announced.username);
  });
});
