import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";
import { NotFoundError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ from: vi.fn(), tallyHashes: vi.fn(), anchorHashes: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from }) }));
vi.mock("./anchors", () => ({ loadTallyHashes: mocks.tallyHashes, loadConfirmedAnchorHashes: mocks.anchorHashes }));

import { loadProposalByNumber, loadProposalEvents, loadProposalListing } from "./governance";

/** The answer each table gives, and the chain each query was built with. */
let answers: Record<string, { data?: unknown; count?: number | null; error: PostgrestError | null }>;
let calls: Record<string, unknown[][]>;

/** A query builder that records its chain and resolves to its table's answer. */
function builder(table: string) {
  const chain: unknown[][] = (calls[table] = []);
  const query: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(answers[table] ?? { data: [], error: null }).then(ok, ko),
  };
  for (const method of ["select", "eq", "in", "not", "order", "limit", "maybeSingle"]) {
    query[method] = (...args: unknown[]) => {
      chain.push([method, ...args]);
      return query;
    };
  }
  return query;
}

beforeEach(() => {
  vi.resetAllMocks();
  answers = {};
  calls = {};
  mocks.from.mockImplementation(builder);
  mocks.tallyHashes.mockResolvedValue(new Map());
  mocks.anchorHashes.mockResolvedValue(new Map());
});

describe("loadProposalByNumber", () => {
  it("loads the community's proposal #N", async () => {
    answers.proposals = { data: { id: "p-1", number: 4 }, error: null };
    expect(await loadProposalByNumber("comm-1", 4)).toEqual({ id: "p-1", number: 4 });
    expect(calls.proposals).toContainEqual(["eq", "community_id", "comm-1"]);
    expect(calls.proposals).toContainEqual(["eq", "number", 4]);
    expect(calls.proposals).toContainEqual(["maybeSingle"]);
  });

  it("is a 404 when the community has no such proposal", async () => {
    answers.proposals = { data: null, error: null };
    await expect(loadProposalByNumber("comm-1", 9)).rejects.toThrow(new NotFoundError("No proposal #9 in this community"));
  });
});

describe("loadProposalEvents", () => {
  it("lists the proposal's steps, oldest first", async () => {
    answers.proposal_events = { data: [{ id: "e-1", action: "created" }], error: null };
    expect(await loadProposalEvents("p-1")).toEqual([{ id: "e-1", action: "created" }]);
    expect(calls.proposal_events).toContainEqual(["eq", "proposal_id", "p-1"]);
    expect(calls.proposal_events).toContainEqual(["order", "occurred_at"]);
  });

  it("throws when the read fails", async () => {
    answers.proposal_events = { data: null, error: new PostgrestError({ message: "permission denied", code: "42501", details: "", hint: "" }) };
    await expect(loadProposalEvents("p-1")).rejects.toThrow("load proposal events: permission denied");
  });
});

describe("loadProposalListing", () => {
  const PROPOSAL = { id: "p-1", number: 4, proposer: "addr_alice", payload: {} };

  it("narrows to proposal #N when a number is given", async () => {
    answers.proposals = { data: [PROPOSAL], count: 1, error: null };
    const listing = await loadProposalListing("comm-1", "addr_me", { open: null, limit: 10, number: 4 });
    expect(listing.proposals).toEqual([PROPOSAL]);
    expect(listing.total).toBe(1);
    expect(calls.proposals).toContainEqual(["eq", "community_id", "comm-1"]);
    expect(calls.proposals).toContainEqual(["eq", "number", 4]);
  });

  it("filters by number 0 too, never treating it as absent", async () => {
    answers.proposals = { data: [], count: 0, error: null };
    await loadProposalListing("comm-1", "addr_me", { open: null, limit: 10, number: 0 });
    expect(calls.proposals).toContainEqual(["eq", "number", 0]);
  });

  it("lists every proposal without a number", async () => {
    answers.proposals = { data: [PROPOSAL], count: 1, error: null };
    await loadProposalListing("comm-1", "addr_me", { open: null, limit: 10 });
    expect(calls.proposals!.filter((c) => c[0] === "eq")).toEqual([["eq", "community_id", "comm-1"]]);
  });
});
