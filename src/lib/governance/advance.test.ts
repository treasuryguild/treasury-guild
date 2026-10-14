import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalRow } from "@/lib/db/types";
import { ConflictError } from "@/lib/errors";
import { tallyProposal } from "./tally";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  choices: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  execute: vi.fn(),
  due: vi.fn(),
  freeze: vi.fn(),
}));
vi.mock("@/lib/db/governance", () => ({
  loadProposal: mocks.load,
  loadProposalChoices: mocks.choices,
  openProposalVoting: mocks.open,
  closeProposal: mocks.close,
  executeProposal: mocks.execute,
  listDueProposalIds: mocks.due,
}));
vi.mock("./freeze", () => ({ tryFreezeTallyDocument: mocks.freeze }));

import { advanceDueProposals, advanceProposal } from "./advance";

const NOW = new Date("2026-09-29T12:00:00Z");
const PAST = "2026-09-29T11:00:00Z";
const FUTURE = "2026-09-30T12:00:00Z";
const rules = {
  method: "majority", electorate: "members", activityMonths: 12, minMemberDays: 0, quorumPct: 20, thresholdPct: 50,
  lazyObjections: 1, discussionHours: 0, votingHours: 72, hideResults: true, recuseBeneficiaries: false,
};
const row = (patch: Partial<ProposalRow>) => ({
  id: "p-1", state: "discussion", voting_starts_at: PAST, closes_at: null, execution_state: null,
  rules, electorate_size: 4, ballot_version: 3, ...patch,
}) as unknown as ProposalRow;

const discussion = row({});
const voting = row({ state: "voting", closes_at: PAST });
const passed = row({ state: "passed", closes_at: PAST, execution_state: "pending" });
const applied = row({ state: "passed", closes_at: PAST, execution_state: "applied" });
const failed = row({ state: "passed", closes_at: PAST, execution_state: "failed" });

/** loadProposal answers these rows in order, then keeps answering the last. */
function states(...sequence: ProposalRow[]) {
  let at = 0;
  mocks.load.mockImplementation(async () => sequence[Math.min(at++, sequence.length - 1)]);
}


beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.choices.mockResolvedValue(["yes", "yes", "no"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("advanceProposal", () => {
  it("does nothing to a proposal with no step due", async () => {
    const waiting = row({ voting_starts_at: FUTURE });
    states(waiting);
    expect(await advanceProposal("p-1", NOW.getTime())).toBe(waiting);
    states(row({ state: "voting", closes_at: FUTURE }));
    await advanceProposal("p-1", NOW.getTime());
    states(row({ state: "rejected", closes_at: PAST, execution_state: "not_applicable" }));
    await advanceProposal("p-1", NOW.getTime());
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("opens voting once the discussion is over", async () => {
    const opened = row({ state: "voting", closes_at: FUTURE });
    states(discussion, opened);
    expect(await advanceProposal("p-1", NOW.getTime())).toBe(opened);
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("p-1");
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("records the tally of the ballots against the version it read", async () => {
    const rejected = row({ state: "rejected", closes_at: PAST, execution_state: "not_applicable" });
    mocks.choices.mockResolvedValue(["yes", "no", "no"]);
    states(voting, rejected);
    expect(await advanceProposal("p-1", NOW.getTime())).toBe(rejected);
    const tally = tallyProposal(rules as unknown as ProposalRow["rules"], 4, ["yes", "no", "no"]);
    expect(tally).toMatchObject({ state: "rejected", reason: "threshold", ballots: 3, electorate: 4 });
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith("p-1", 3, tally);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("counts an electorate never snapshotted as empty", async () => {
    states(row({ state: "voting", closes_at: PAST, electorate_size: null }), row({ state: "expired", closes_at: PAST }));
    mocks.choices.mockResolvedValue([]);
    await advanceProposal("p-1", NOW.getTime());
    expect(mocks.close.mock.calls[0]![2]).toMatchObject({ electorate: 0, ballots: 0, state: "expired", reason: "no_votes" });
  });

  it("carries out a passed proposal as the sweep (no actor)", async () => {
    states(passed, applied);
    expect(await advanceProposal("p-1", NOW.getTime())).toBe(applied);
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith("p-1", null);
  });

  it("takes every due step in one run: open, close (freezing the record), execute", async () => {
    // The row is read once more right after the close, for the freeze.
    states(discussion, voting, passed, passed, applied);
    expect(await advanceProposal("p-1", NOW.getTime())).toBe(applied);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.close.mock.calls[0]![2]).toMatchObject({ state: "passed", reason: "passed" });
    expect(mocks.freeze).toHaveBeenCalledTimes(1);
    expect(mocks.freeze).toHaveBeenCalledWith(passed);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.open.mock.invocationCallOrder[0]!).toBeLessThan(mocks.close.mock.invocationCallOrder[0]!);
    expect(mocks.close.mock.invocationCallOrder[0]!).toBeLessThan(mocks.freeze.mock.invocationCallOrder[0]!);
    expect(mocks.freeze.mock.invocationCallOrder[0]!).toBeLessThan(mocks.execute.mock.invocationCallOrder[0]!);
  });

  it("never takes more than three steps, even if the row never moves", async () => {
    states(discussion);
    expect(await advanceProposal("p-1", NOW.getTime())).toBe(discussion);
    expect(mocks.open).toHaveBeenCalledTimes(3);
  });

  it("leaves a refused step (clock skew, a ballot race) for the next run", async () => {
    states(voting);
    mocks.close.mockRejectedValue(new ConflictError("ballots changed"));
    expect(await advanceProposal("p-1", NOW.getTime())).toBe(voting);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("throws anything else", async () => {
    states(discussion);
    mocks.open.mockRejectedValue(new Error("database is down"));
    await expect(advanceProposal("p-1", NOW.getTime())).rejects.toThrow("database is down");
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it("stops at an execution the RPC recorded as failed", async () => {
    // execute_proposal records the failure on the row and returns normally.
    mocks.execute.mockResolvedValue("failed");
    states(passed, failed);
    expect(await advanceProposal("p-1", NOW.getTime())).toBe(failed);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed execution", async () => {
    states(failed);
    expect(await advanceProposal("p-1", NOW.getTime())).toBe(failed);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("advanceDueProposals", () => {
  /** Each proposal id answers its own row sequence. */
  function proposals(byId: Record<string, ProposalRow[]>) {
    const at: Record<string, number> = {};
    mocks.load.mockImplementation(async (id: string) => {
      const sequence = byId[id]!;
      const index = Math.min(at[id] ?? 0, sequence.length - 1);
      at[id] = index + 1;
      return sequence[index];
    });
  }

  it("takes the due step of every listed proposal, at the sweep's clock", async () => {
    mocks.due.mockResolvedValue(["p-open", "p-close", "p-run"]);
    proposals({
      "p-open": [discussion, row({ state: "voting", closes_at: FUTURE })],
      "p-close": [voting, row({ state: "rejected", closes_at: PAST })],
      "p-run": [passed, applied],
    });
    expect(await advanceDueProposals(NOW)).toEqual({ advanced: 3, failed: 0 });
    expect(mocks.due).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("p-open");
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith("p-close", 3, expect.objectContaining({ ballots: 3 }));
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith("p-run", null);
  });

  it("uses the given time, not the wall clock, to decide what is due", async () => {
    mocks.due.mockResolvedValue(["p-1"]);
    proposals({ "p-1": [row({ voting_starts_at: FUTURE })] });
    await advanceDueProposals(NOW);
    expect(mocks.open).not.toHaveBeenCalled();
    await advanceDueProposals(new Date("2026-10-01T00:00:00Z"));
    expect(mocks.open).toHaveBeenCalled();
  });

  it("keeps going when one proposal fails, and counts it", async () => {
    mocks.due.mockResolvedValue(["p-bad", "p-gone", "p-good"]);
    proposals({ "p-bad": [discussion], "p-gone": [passed], "p-good": [passed, applied] });
    mocks.open.mockRejectedValue(new Error("database is down"));
    mocks.execute.mockImplementation(async (id: string) => {
      if (id === "p-gone") throw new Error("rpc timeout");
      return "applied";
    });
    expect(await advanceDueProposals(NOW)).toEqual({ advanced: 1, failed: 2 });
    expect(mocks.execute).toHaveBeenCalledWith("p-good", null);
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(console.error).mock.calls[0]![0])).toContain("p-bad");
  });

  it("counts a refused step as handled, not failed", async () => {
    mocks.due.mockResolvedValue(["p-1"]);
    proposals({ "p-1": [voting] });
    mocks.close.mockRejectedValue(new ConflictError("still open"));
    expect(await advanceDueProposals(NOW)).toEqual({ advanced: 1, failed: 0 });
  });

  it("records a failed execution once and leaves it to an admin on later sweeps", async () => {
    mocks.due.mockResolvedValue(["p-1"]);
    mocks.execute.mockResolvedValue("failed");
    proposals({ "p-1": [passed, failed] });
    await advanceDueProposals(NOW);
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith("p-1", null);

    // Even if a later run is handed the proposal again, it is not carried out again.
    await advanceDueProposals(new Date(NOW.getTime() + 3_600_000));
    await advanceDueProposals(new Date(NOW.getTime() + 7_200_000));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no proposal is due", async () => {
    mocks.due.mockResolvedValue([]);
    expect(await advanceDueProposals(NOW)).toEqual({ advanced: 0, failed: 0 });
    expect(mocks.load).not.toHaveBeenCalled();
  });
});
