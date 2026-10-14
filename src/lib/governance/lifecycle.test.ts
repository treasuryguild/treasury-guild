import { describe, expect, it } from "vitest";
import { ProposalState } from "@/lib/constants";
import type { ProposalRules } from "./rules";
import { ballotsVisible, canCancel, canWithdraw, dueAction, isOpenProposal, isVotingOpen } from "./lifecycle";

const now = Date.parse("2026-09-29T12:00:00Z");
const before = "2026-09-29T11:00:00Z";
const after = "2026-09-29T13:00:00Z";
const base = { voting_starts_at: after, closes_at: null, execution_state: null } as const;

describe("dueAction", () => {
  it("opens voting once the discussion is over", () => {
    expect(dueAction({ ...base, state: "discussion" }, now)).toBeNull();
    expect(dueAction({ ...base, state: "discussion", voting_starts_at: before }, now)).toBe("open");
  });

  it("closes at the deadline and carries out a passed proposal once", () => {
    expect(dueAction({ ...base, state: "voting", closes_at: after }, now)).toBeNull();
    expect(dueAction({ ...base, state: "voting", closes_at: before }, now)).toBe("close");
    expect(dueAction({ ...base, state: "passed", execution_state: "pending" }, now)).toBe("execute");
    expect(dueAction({ ...base, state: "passed", execution_state: "failed" }, now)).toBeNull();
    expect(dueAction({ ...base, state: "rejected", execution_state: "not_applicable" }, now)).toBeNull();
  });
});

describe("permissions", () => {
  it("lets the proposer withdraw only before voting", () => {
    expect(canWithdraw({ state: "discussion", proposer: "me" }, "me")).toBe(true);
    expect(canWithdraw({ state: "voting", proposer: "me" }, "me")).toBe(false);
    expect(canWithdraw({ state: "discussion", proposer: "me" }, "you")).toBe(false);
  });

  it("lets admins cancel while open", () => {
    expect(canCancel({ state: "voting" }, true)).toBe(true);
    expect(canCancel({ state: "passed" }, true)).toBe(false);
    expect(canCancel({ state: "voting" }, false)).toBe(false);
  });

  it("accepts ballots only before the deadline", () => {
    expect(isVotingOpen({ state: "voting", closes_at: after }, now)).toBe(true);
    expect(isVotingOpen({ state: "voting", closes_at: before }, now)).toBe(false);
  });

  it("shows ballots after the close, or live when results are not hidden", () => {
    const rules = { hideResults: true } as ProposalRules;
    expect(ballotsVisible({ state: "voting", rules })).toBe(false);
    expect(ballotsVisible({ state: "expired", rules })).toBe(true);
    expect(ballotsVisible({ state: "voting", rules: { ...rules, hideResults: false } })).toBe(true);
  });
});

describe("isOpenProposal", () => {
  it("is true while a proposal is discussed or voted on, false for every ended state", () => {
    const open = Object.values(ProposalState).filter(isOpenProposal);
    expect(open.sort()).toEqual([ProposalState.Discussion, ProposalState.Voting].sort());
    for (const state of [ProposalState.Passed, ProposalState.Rejected, ProposalState.Expired, ProposalState.Withdrawn, ProposalState.Cancelled]) {
      expect(isOpenProposal(state), state).toBe(false);
    }
  });

  it("is false for anything that is not a state", () => {
    for (const state of ["", "open", "Voting", "DISCUSSION", " voting"]) expect(isOpenProposal(state), state).toBe(false);
  });

  it("is what cancelling and hidden results depend on, for every state", () => {
    const rules = { hideResults: true } as ProposalRules;
    for (const state of Object.values(ProposalState)) {
      expect(canCancel({ state }, true), state).toBe(isOpenProposal(state));
      expect(ballotsVisible({ state, rules }), state).toBe(!isOpenProposal(state));
    }
  });
});
