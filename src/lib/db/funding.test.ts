import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from }) }));

import { loadFundingOverview } from "./funding";

/** The rows each table answers, and the chain each query was built with. */
let answers: Record<string, { data?: unknown; error: PostgrestError | null }>;
let calls: Record<string, unknown[][]>;

/** A query builder that records its chain and resolves to its table's answer. */
function builder(table: string) {
  const chain: unknown[][] = (calls[table] = []);
  const query: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(answers[table] ?? { data: [], error: null }).then(ok, ko),
  };
  for (const method of ["select", "eq", "in", "not", "order"]) {
    query[method] = (...args: unknown[]) => {
      chain.push([method, ...args]);
      return query;
    };
  }
  return query;
}

const tables = () => mocks.from.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.resetAllMocks();
  answers = {};
  calls = {};
  mocks.from.mockImplementation(builder);
});

describe("loadFundingOverview", () => {
  it("reads the community's sources and commitments, and only the periods of schedules", async () => {
    answers.funding_sources = { data: [{ id: "s-1", name: "Catalyst" }], error: null };
    answers.funding_commitments = {
      data: [{ id: "c-1", kind: "one_off" }, { id: "c-2", kind: "schedule" }, { id: "c-3", kind: "recurring" }, { id: "c-4", kind: "schedule" }],
      error: null,
    };
    answers.funding_commitment_periods = { data: [{ id: "per-1", commitment_id: "c-2" }], error: null };
    answers.incoming_txs = { data: [{ tx_hash: "h-1", funding_source_id: "s-1" }], error: null };
    const overview = await loadFundingOverview("comm-1", ["t-1", "t-2"]);
    expect(overview).toEqual({
      sources: [{ id: "s-1", name: "Catalyst" }],
      commitments: answers.funding_commitments.data,
      periods: [{ id: "per-1", commitment_id: "c-2" }],
      inflows: [{ tx_hash: "h-1", funding_source_id: "s-1" }],
    });
    expect(calls.funding_sources).toContainEqual(["eq", "community_id", "comm-1"]);
    expect(calls.funding_commitments).toContainEqual(["eq", "community_id", "comm-1"]);
    expect(calls.funding_commitment_periods).toContainEqual(["in", "commitment_id", ["c-2", "c-4"]]);
  });

  it("reads only the inflows of the community's treasuries that carry a funding tag", async () => {
    await loadFundingOverview("comm-1", ["t-1", "t-2"]);
    expect(calls.incoming_txs).toContainEqual(["in", "treasury_id", ["t-1", "t-2"]]);
    expect(calls.incoming_txs).toContainEqual(["not", "funding_source_id", "is", null]);
  });

  it("skips the period read without schedules and the inflow read without treasuries", async () => {
    answers.funding_commitments = { data: [{ id: "c-1", kind: "one_off" }], error: null };
    expect(await loadFundingOverview("comm-1", [])).toEqual({
      sources: [], commitments: [{ id: "c-1", kind: "one_off" }], periods: [], inflows: [],
    });
    expect(tables()).toEqual(["funding_sources", "funding_commitments"]);
  });

  it("throws when a read fails", async () => {
    answers.incoming_txs = { data: null, error: new PostgrestError({ message: "timeout", code: "57014", details: "", hint: "" }) };
    await expect(loadFundingOverview("comm-1", ["t-1"])).rejects.toThrow("load funded inflows: timeout");
  });
});
