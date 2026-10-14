import { describe, expect, it } from "vitest";
import { DecisionMethod, ProposalKind } from "@/lib/constants";
import type { GovernanceSettingsRow } from "@/lib/db/types";
import { canonicalJson, DEFAULT_SETTINGS, rulesFor, settingsFromRow, settingsToRow } from "./rules";

describe("canonicalJson", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: "x" } })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson({ z: 1, a: 2 })).toBe(canonicalJson({ a: 2, z: 1 }));
  });
});

describe("settings", () => {
  it("defaults every kind to off, budgets to consent by managers", () => {
    expect(settingsFromRow(null, ProposalKind.Budget)).toMatchObject({
      enabled: false, method: DecisionMethod.Consent, proposers: "managers",
    });
    expect(Object.values(DEFAULT_SETTINGS).every((s) => !s.enabled)).toBe(true);
  });

  it("round-trips through the row shape", () => {
    const settings = { ...DEFAULT_SETTINGS.task, enabled: true, lazyCapLovelace: "5000000" };
    const row = { ...settingsToRow(settings), community_id: "c", kind: "task", updated_by: "a", updated_at: "t" } as GovernanceSettingsRow;
    expect(settingsFromRow(row, ProposalKind.Task)).toEqual(settings);
  });
});

describe("rulesFor", () => {
  it("freezes the voting rules, not who may propose", () => {
    const rules = rulesFor(DEFAULT_SETTINGS.budget);
    expect(rules).not.toHaveProperty("proposers");
    expect(rules).not.toHaveProperty("enabled");
    expect(rules.method).toBe(DecisionMethod.Consent);
  });

  it("escalates lazy consensus only when asked and configured", () => {
    expect(rulesFor(DEFAULT_SETTINGS.task).method).toBe(DecisionMethod.Lazy);
    expect(rulesFor(DEFAULT_SETTINGS.task, { escalate: true }).method).toBe(DecisionMethod.Majority);
    expect(rulesFor({ ...DEFAULT_SETTINGS.task, escalateMethod: null }, { escalate: true }).method).toBe(DecisionMethod.Lazy);
    expect(rulesFor(DEFAULT_SETTINGS.decision, { escalate: true }).method).toBe(DecisionMethod.Majority);
  });
});
