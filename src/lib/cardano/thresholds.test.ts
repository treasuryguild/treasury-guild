import { describe, expect, it } from "vitest";
import type { SigningRule } from "./spendingPaths";
import {
  describeRule,
  describeThreshold,
  requiredSignatures,
  thresholdReached,
  thresholdStillReachable,
} from "./thresholds";

const members = ["a", "b", "c"];
const rule = (scriptType: SigningRule["scriptType"], required = 2, alsoRequired: string[] = []): SigningRule =>
  ({ scriptType, required, members, alsoRequired });

describe("requiredSignatures", () => {
  it("is the group's count plus every co-signer", () => {
    expect(requiredSignatures({ scriptType: "all", required: 1, members: ["a", "b", "c", "d"], alsoRequired: [] })).toBe(4);
    expect(requiredSignatures({ scriptType: "any", required: 3, members: ["a", "b"], alsoRequired: [] })).toBe(1);
    expect(requiredSignatures(rule("atLeast", 2, ["co"]))).toBe(3);
  });

  it("agrees with thresholdReached", () => {
    const r = rule("atLeast", 2, ["co"]);
    expect(thresholdReached(r, ["a", "b", "co"])).toBe(true);
    expect(["a", "b", "co"].length).toBe(requiredSignatures(r));
  });
});

describe("describeThreshold", () => {
  it("describes each script type, with N when the count is unknown", () => {
    expect(describeThreshold("atLeast", 2, 3)).toBe("2 of 3");
    expect(describeThreshold("atLeast", 2, null)).toBe("2 of N");
    expect(describeThreshold("all", 1, 3)).toBe("all 3 signers");
    expect(describeThreshold("any", 1, 3)).toBe("any signer");
    expect(describeRule(rule("atLeast"))).toBe("2 of 3");
    expect(describeRule(rule("atLeast", 2, ["co"]))).toBe("2 of 3 + co-signer");
  });
});

describe("thresholdReached", () => {
  it("atLeast: signatures of members >= required", () => {
    expect(thresholdReached(rule("atLeast"), ["a"])).toBe(false);
    expect(thresholdReached(rule("atLeast"), ["a", "b"])).toBe(true);
    expect(thresholdReached(rule("atLeast"), ["a", "b", "c"])).toBe(true);
  });

  it("all: every member required", () => {
    expect(thresholdReached(rule("all"), ["a", "b"])).toBe(false);
    expect(thresholdReached(rule("all"), ["a", "b", "c"])).toBe(true);
  });

  it("any: one signature suffices", () => {
    expect(thresholdReached(rule("any", 3), [])).toBe(false);
    expect(thresholdReached(rule("any", 3), ["b"])).toBe(true);
  });

  it("counts only the rule's members and needs every co-signer", () => {
    expect(thresholdReached(rule("atLeast"), ["a", "x"])).toBe(false);
    expect(thresholdReached(rule("atLeast", 2, ["co"]), ["a", "b", "c"])).toBe(false);
    expect(thresholdReached(rule("atLeast", 2, ["co"]), ["a", "co", "b"])).toBe(true);
    expect(thresholdReached(rule("atLeast", 2, ["co"]), ["co", "a"])).toBe(false);
  });
});

describe("thresholdStillReachable", () => {
  it("atLeast: dead when the remaining members cannot reach required", () => {
    expect(thresholdStillReachable(rule("atLeast"), ["a"], ["b"])).toBe(true);
    expect(thresholdStillReachable(rule("atLeast"), [], ["b", "c"])).toBe(false);
  });

  it("all: any rejection kills the tx", () => {
    expect(thresholdStillReachable(rule("all"), ["a", "b"], ["c"])).toBe(false);
    expect(thresholdStillReachable(rule("all"), ["a", "b"], [])).toBe(true);
  });

  it("any: alive while someone signed or someone is left", () => {
    expect(thresholdStillReachable(rule("any"), [], ["a", "b"])).toBe(true);
    expect(thresholdStillReachable(rule("any"), [], ["a", "b", "c"])).toBe(false);
  });

  it("a rejecting co-signer kills the tx; a stranger's rejection changes nothing", () => {
    expect(thresholdStillReachable(rule("atLeast", 2, ["co"]), ["a", "b"], ["co"])).toBe(false);
    expect(thresholdStillReachable(rule("atLeast", 2, ["co"]), ["a"], ["x"])).toBe(true);
  });
});
