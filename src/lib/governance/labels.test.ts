import { describe, expect, it } from "vitest";
import { METHOD_CHOICES, VoteChoice } from "@/lib/constants";
import {
  CHOICE_LABELS, describeElectorate, describeHours, describeMethod, describeRulesChanges,
  proposalTiming, proposalVoteIndicator, relativeTime, voterName,
} from "./labels";
import { DEFAULT_SETTINGS, rulesFor } from "./rules";

describe("rule descriptions", () => {
  it("describes electorates with their windows", () => {
    expect(describeElectorate(rulesFor(DEFAULT_SETTINGS.decision))).toBe("All members");
    expect(describeElectorate({ electorate: "contributors", activityMonths: 1, minMemberDays: 30 }))
      .toBe("Recently paid contributors (last 1 month), members for at least 30 days");
  });

  it("describes methods", () => {
    expect(describeMethod(rulesFor(DEFAULT_SETTINGS.budget))).toBe("Consent, quorum 25%");
    expect(describeMethod(rulesFor(DEFAULT_SETTINGS.decision))).toBe("Majority vote above 50%, quorum 20%");
    expect(describeMethod(rulesFor(DEFAULT_SETTINGS.task))).toBe("Lazy consensus, 1 objection rejects");
  });

  it("describes periods", () => {
    expect(describeHours(0)).toBe("none");
    expect(describeHours(48)).toBe("2 days");
    expect(describeHours(36)).toBe("36 hours");
  });

  it("names only the rules that differ from the community default", () => {
    const baseline = rulesFor(DEFAULT_SETTINGS.decision);
    expect(describeRulesChanges(baseline, baseline)).toEqual([]);
    expect(describeRulesChanges({ ...baseline, votingHours: 48, hideResults: false }, baseline)).toEqual([
      "Voting: 2 days, community default is 5 days",
      "Results: shown while voting runs, community default is hidden until voting closes",
    ]);
    // A quorum does not decide a lazy-consensus proposal, so changing it is not named.
    const lazy = rulesFor(DEFAULT_SETTINGS.task);
    expect(describeRulesChanges({ ...lazy, quorumPct: 80 }, lazy)).toEqual([]);
  });

  it("labels every choice of every method", () => {
    for (const choices of Object.values(METHOD_CHOICES)) {
      for (const choice of choices) expect(CHOICE_LABELS[choice]).toBeTruthy();
    }
  });
});

describe("timing", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  it("states the largest whole unit either way", () => {
    expect(relativeTime("2026-10-02T13:00:00Z", now)).toBe("in 3 days");
    expect(relativeTime("2026-09-29T17:30:00Z", now)).toBe("in 5 hours");
    expect(relativeTime("2026-09-29T12:20:00Z", now)).toBe("in 20 minutes");
    expect(relativeTime("2026-09-29T11:00:00Z", now)).toBe("60 minutes ago");
    expect(relativeTime("2026-09-29T12:00:10Z", now)).toBe("in a moment");
  });

  it("describes where a proposal stands", () => {
    const base = { voting_starts_at: "2026-09-30T12:00:00Z", closes_at: null, closed_at: null };
    expect(proposalTiming({ ...base, state: "discussion" }, now)).toBe("Voting opens in 24 hours");
    expect(proposalTiming({ ...base, state: "voting", closes_at: "2026-10-04T12:00:00Z" }, now)).toBe("Voting closes in 5 days");
    expect(proposalTiming({ ...base, state: "voting", closes_at: "2026-09-29T11:00:00Z" }, now)).toBe("Voting closed, counting shortly");
    expect(proposalTiming({ ...base, state: "passed", closed_at: "2026-09-26T12:00:00Z" }, now)).toBe("Closed 3 days ago");
  });

  it("names voters by handle, else a short wallet", () => {
    expect(voterName("addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "  ")).toBe("addr_test1…qqqqqq");
    expect(voterName("addr", "ana")).toBe("ana");
  });
});

describe("proposalVoteIndicator", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const open = { state: "voting", closes_at: "2026-10-04T12:00:00Z" };
  const discussion = { state: "discussion", closes_at: null };
  const closed = { state: "passed", closes_at: "2026-09-28T12:00:00Z" };
  const seat = { recused: false };

  it("flags an open vote the caller still owes", () => {
    expect(proposalVoteIndicator(open, now, seat, undefined))
      .toEqual({ label: "Not voted", tone: "yellow" });
  });

  it("shows the caller's choice once they have voted", () => {
    expect(proposalVoteIndicator(open, now, seat, VoteChoice.Agree))
      .toEqual({ label: "Voted · Agree", tone: "green" });
    expect(proposalVoteIndicator(closed, now, seat, VoteChoice.No))
      .toEqual({ label: "Voted · No", tone: "green" });
  });

  it("omits discussion, ineligible seats and recusals without a ballot", () => {
    expect(proposalVoteIndicator(discussion, now, seat, undefined)).toBeNull();
    expect(proposalVoteIndicator(open, now, undefined, undefined)).toBeNull();
    expect(proposalVoteIndicator(open, now, { recused: true }, undefined)).toBeNull();
    expect(proposalVoteIndicator(closed, now, seat, undefined)).toBeNull();
  });
});
