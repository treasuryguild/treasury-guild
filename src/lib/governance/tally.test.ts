import { describe, expect, it } from "vitest";
import { DecisionMethod } from "@/lib/constants";
import { tallyProposal, turnoutPct } from "./tally";

const consent = { method: DecisionMethod.Consent, quorumPct: 25, thresholdPct: 50, lazyObjections: 1 };
const majority = { method: DecisionMethod.Majority, quorumPct: 20, thresholdPct: 50, lazyObjections: 1 };
const lazy = { method: DecisionMethod.Lazy, quorumPct: 50, thresholdPct: 50, lazyObjections: 2 };

describe("tallyProposal", () => {
  it("passes consent with no block and more agree than disagree", () => {
    const t = tallyProposal(consent, 8, ["agree", "agree", "disagree"]);
    expect(t).toMatchObject({ state: "passed", reason: "passed", quorumMet: true, ballots: 3 });
    expect(t.counts).toEqual({ agree: 2, disagree: 1 });
  });

  it("rejects consent on a single block, whatever the support", () => {
    expect(tallyProposal(consent, 4, ["agree", "agree", "agree", "block"])).toMatchObject({ state: "rejected", reason: "blocked" });
  });

  it("rejects consent when agree does not exceed disagree", () => {
    expect(tallyProposal(consent, 4, ["agree", "disagree"])).toMatchObject({ state: "rejected", reason: "support" });
    expect(tallyProposal(consent, 4, ["abstain", "abstain"])).toMatchObject({ state: "rejected", reason: "support" });
  });

  it("expires without quorum, counting abstentions toward it", () => {
    expect(tallyProposal(consent, 8, ["agree"])).toMatchObject({ state: "expired", reason: "quorum", quorumMet: false });
    // Exactly 25% of 8.
    expect(tallyProposal(consent, 8, ["agree", "abstain"])).toMatchObject({ state: "passed", quorumMet: true });
    expect(tallyProposal({ ...consent, quorumPct: 0 }, 8, [])).toMatchObject({ state: "expired", reason: "no_votes" });
  });

  it("needs strictly more yes than the threshold of yes + no", () => {
    expect(tallyProposal(majority, 10, ["yes", "no"])).toMatchObject({ state: "rejected", reason: "threshold" });
    expect(tallyProposal(majority, 10, ["yes", "yes", "no", "abstain"])).toMatchObject({ state: "passed" });
    expect(tallyProposal({ ...majority, thresholdPct: 66 }, 10, ["yes", "yes", "no"])).toMatchObject({ state: "passed" });
    expect(tallyProposal({ ...majority, thresholdPct: 67 }, 10, ["yes", "yes", "no"])).toMatchObject({ state: "rejected" });
    expect(tallyProposal(majority, 10, ["abstain", "abstain"])).toMatchObject({ state: "rejected", reason: "threshold" });
  });

  it("passes lazy consensus unless enough members object, with no quorum", () => {
    expect(tallyProposal(lazy, 50, [])).toMatchObject({ state: "passed", quorumMet: true });
    expect(tallyProposal(lazy, 50, ["object", "agree"])).toMatchObject({ state: "passed" });
    expect(tallyProposal(lazy, 50, ["object", "object"])).toMatchObject({ state: "rejected", reason: "objections" });
  });
});

describe("turnoutPct", () => {
  it("rounds down and survives an empty electorate", () => {
    expect(turnoutPct(1, 3)).toBe(33);
    expect(turnoutPct(0, null)).toBe(0);
  });
});
