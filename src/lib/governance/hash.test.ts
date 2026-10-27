import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DecisionMethod, Electorate, ProposalKind } from "@/lib/constants";
import { proposalContentHash, proposalRulesHash } from "./hash";
import type { ProposalRules } from "./rules";

const rules: ProposalRules = {
  method: DecisionMethod.Majority,
  electorate: Electorate.Members,
  activityMonths: 12,
  minMemberDays: 0,
  quorumPct: 20,
  thresholdPct: 50,
  lazyObjections: 1,
  discussionHours: 48,
  votingHours: 120,
  hideResults: true,
  recuseBeneficiaries: false,
};

const content = {
  kind: ProposalKind.Task,
  title: "Write the docs",
  body: "A page per flow.",
  discussionUrl: null,
  payload: {
    task: { workgroupId: "wg-1", amounts: { ADA: "25", AGIX: "100" }, bountyLovelace: "25000000", assignSelf: true },
  },
  replaces: null as number | null,
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("proposalRulesHash", () => {
  it("is the sha256 of the rules as sorted-key JSON", () => {
    expect(proposalRulesHash(rules)).toBe(
      sha256(
        '{"activityMonths":12,"discussionHours":48,"electorate":"members","hideResults":true,"lazyObjections":1,' +
          '"method":"majority","minMemberDays":0,"quorumPct":20,"recuseBeneficiaries":false,"thresholdPct":50,"votingHours":120}',
      ),
    );
  });

  it("is deterministic and independent of key order", () => {
    const reversed = Object.fromEntries(Object.entries(rules).reverse()) as unknown as ProposalRules;
    expect(Object.keys(reversed)).not.toEqual(Object.keys(rules));
    expect(proposalRulesHash(reversed)).toBe(proposalRulesHash(rules));
    expect(proposalRulesHash({ ...rules })).toBe(proposalRulesHash(rules));
    expect(proposalRulesHash(rules)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["method", { method: DecisionMethod.Consent }],
    ["electorate", { electorate: Electorate.Admins }],
    ["activityMonths", { activityMonths: 6 }],
    ["minMemberDays", { minMemberDays: 1 }],
    ["quorumPct", { quorumPct: 21 }],
    ["thresholdPct", { thresholdPct: 51 }],
    ["lazyObjections", { lazyObjections: 2 }],
    ["discussionHours", { discussionHours: 0 }],
    ["votingHours", { votingHours: 121 }],
    ["hideResults", { hideResults: false }],
    ["recuseBeneficiaries", { recuseBeneficiaries: true }],
  ] satisfies [string, Partial<ProposalRules>][])("changes when %s changes", (_field, change) => {
    expect(proposalRulesHash({ ...rules, ...change })).not.toBe(proposalRulesHash(rules));
  });
});

describe("proposalContentHash", () => {
  it("is the sha256 of the content as sorted-key JSON, nested objects included", () => {
    expect(proposalContentHash({ kind: ProposalKind.Decision, title: "T", body: "B", discussionUrl: null, payload: {}, replaces: null })).toBe(
      sha256('{"body":"B","discussionUrl":null,"kind":"decision","payload":{},"replaces":null,"title":"T"}'),
    );
    expect(proposalContentHash(content)).toBe(
      sha256(
        '{"body":"A page per flow.","discussionUrl":null,"kind":"task","payload":{"task":{"amounts":{"ADA":"25","AGIX":"100"},' +
          '"assignSelf":true,"bountyLovelace":"25000000","workgroupId":"wg-1"}},"replaces":null,"title":"Write the docs"}',
      ),
    );
  });

  it("ignores key order at every level", () => {
    const shuffled = {
      payload: {
        task: { assignSelf: true, bountyLovelace: "25000000", amounts: { AGIX: "100", ADA: "25" }, workgroupId: "wg-1" },
      },
      discussionUrl: null,
      body: "A page per flow.",
      title: "Write the docs",
      kind: ProposalKind.Task,
      replaces: null,
    };
    expect(proposalContentHash(shuffled)).toBe(proposalContentHash(content));
  });

  it("changes with every field", () => {
    const base = proposalContentHash(content);
    expect(proposalContentHash({ ...content, kind: ProposalKind.Decision })).not.toBe(base);
    expect(proposalContentHash({ ...content, title: "Write the docs." })).not.toBe(base);
    expect(proposalContentHash({ ...content, body: "" })).not.toBe(base);
    expect(proposalContentHash({ ...content, discussionUrl: "https://example.com/t/1" })).not.toBe(base);
    expect(
      proposalContentHash({ ...content, payload: { task: { ...content.payload.task, amounts: { ADA: "26", AGIX: "100" } } } }),
    ).not.toBe(base);
    expect(
      proposalContentHash({ ...content, payload: { task: { ...content.payload.task, assignSelf: false } } }),
    ).not.toBe(base);
    expect(proposalContentHash({ ...content, replaces: 3 })).not.toBe(base);
  });

  it("keeps array order significant: reordered budget steps are a different proposal", () => {
    const step = (workgroupId: string) => ({
      workgroupId,
      treasuryId: null,
      mode: "fixed" as never,
      cadence: "monthly" as never,
      startsOn: "2026-10-01",
      amounts: [],
      confirm: false,
      reason: "",
    });
    const budget = (ids: string[]) =>
      proposalContentHash({ kind: ProposalKind.Budget, title: "B", body: "", discussionUrl: null, payload: { steps: ids.map(step) }, replaces: null });
    expect(budget(["a", "b"])).toBe(budget(["a", "b"]));
    expect(budget(["a", "b"])).not.toBe(budget(["b", "a"]));
  });

  it("does not collide a title with a body carrying the same text", () => {
    const a = proposalContentHash({ ...content, title: "x", body: "y" });
    const b = proposalContentHash({ ...content, title: "y", body: "x" });
    expect(a).not.toBe(b);
  });
});
