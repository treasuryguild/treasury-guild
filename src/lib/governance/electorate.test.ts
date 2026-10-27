import { describe, expect, it } from "vitest";
import { eligibleVoterCount, noEligibleVotersReason } from "./electorate";

const ann = "addr_ann";
const bo = "addr_bo";

describe("eligibleVoterCount", () => {
  it("counts the whole electorate when nobody is recused", () => {
    expect(eligibleVoterCount([ann, bo], [ann], false)).toBe(2);
    expect(eligibleVoterCount([ann, bo], [], true)).toBe(2);
    expect(eligibleVoterCount([], [ann], true)).toBe(0);
  });

  it("drops beneficiaries, and only them, when recusal is on", () => {
    expect(eligibleVoterCount([ann, bo], [ann], true)).toBe(1);
    expect(eligibleVoterCount([ann], [ann, bo], true)).toBe(0);
    expect(eligibleVoterCount([ann, ann], [ann], true)).toBe(0);
  });
});

describe("noEligibleVotersReason", () => {
  it("says nothing when someone can vote", () => {
    expect(noEligibleVotersReason(3, 1)).toBeNull();
  });

  it("names an empty electorate and one that recusal empties", () => {
    expect(noEligibleVotersReason(0, 0)).toMatch(/Nobody can vote/);
    expect(noEligibleVotersReason(0, 0)).toMatch(/how long a member must have belonged/);
    expect(noEligibleVotersReason(2, 0)).toMatch(/would be recused/);
    expect(noEligibleVotersReason(2, 0)).toMatch(/Turn recusal off/);
    expect(noEligibleVotersReason(0, 0)).not.toBe(noEligibleVotersReason(2, 0));
  });
});
