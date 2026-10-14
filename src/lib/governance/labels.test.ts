import { describe, expect, it } from "vitest";
import { METHOD_CHOICES } from "@/lib/constants";
import {
  CHOICE_LABELS, describeElectorate, describeHours, describeMethod, proposalTiming, relativeTime, voterName,
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
