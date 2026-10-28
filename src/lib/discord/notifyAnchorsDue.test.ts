import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbClient from "@/lib/db/client";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  loadCandidates: vi.fn(),
  loadStamps: vi.fn(),
  stamp: vi.fn(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof DbClient>()),
  serviceClient: () => ({ from: mocks.from }),
  rows: (res: { data: unknown; error: unknown }, what: string) => {
    if (res.error) throw new Error(what);
    return res.data ?? [];
  },
  check: (res: { error: unknown }, what: string) => {
    if (res.error) throw new Error(what);
  },
}));
vi.mock("@/lib/governance/anchorsDue", () => ({
  loadAnchorAlertCandidates: mocks.loadCandidates,
}));
vi.mock("@/lib/db/anchorAlerts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db/anchorAlerts")>();
  return {
    ...real,
    loadAnchorAlertStamps: mocks.loadStamps,
    stampAnchorAlerts: mocks.stamp,
  };
});

import { notifyAnchorsDue, stampCurrentAnchorAlerts } from "./notifyAnchorsDue";

const NOW = new Date("2026-10-04T12:00:00Z");

interface Op { table: string; op: "select" | "update"; values?: Record<string, unknown>; filters: [string, unknown][] }
let ops: Op[];

function builder(table: string) {
  const op: Op = { table, op: "select", filters: [] };
  const respond = () => {
    if (op.op === "update") return { data: null, error: null };
    if (table === "governance_discord_webhooks") {
      return { data: [{ community_id: "c-1", url: "https://discord.com/api/webhooks/1/tok" }], error: null };
    }
    if (table === "communities") return { data: [{ id: "c-1", name: "Guild", slug: "guild" }], error: null };
    return { data: [], error: null };
  };
  const record = (k: string, v: unknown) => { op.filters.push([k, v]); return chain; };
  const chain = {
    select: () => chain,
    update: (values: Record<string, unknown>) => { op.op = "update"; op.values = values; return chain; },
    eq: record, in: record,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      ops.push(op);
      return Promise.resolve(respond()).then(resolve, reject);
    },
  };
  return chain;
}

beforeAll(() => {
  process.env.APP_URL = "https://app.example";
});

beforeEach(() => {
  ops = [];
  mocks.from.mockImplementation(builder);
  mocks.loadCandidates.mockReset();
  mocks.loadStamps.mockReset().mockResolvedValue([]);
  mocks.stamp.mockReset().mockResolvedValue(undefined);
});

const stale = {
  proposalId: "p-1", number: 3, title: "Budget", step: "proposed" as const,
  kind: "stale" as const, dueSince: "2026-09-20T00:00:00.000Z",
};
const grace = {
  proposalId: "p-2", number: 4, title: "Hire", step: "closed" as const,
  kind: "copy_grace" as const, dueSince: "2026-10-01T00:00:00.000Z",
};

describe("notifyAnchorsDue", () => {
  it("posts a stale digest and a copy-grace embed, then stamps", async () => {
    mocks.loadCandidates.mockResolvedValue([stale, grace]);
    const titles: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      titles.push(JSON.parse(String(init.body)).embeds[0].title);
      return new Response(null, { status: 204 });
    });
    expect(await notifyAnchorsDue(NOW, { fetchImpl })).toEqual({ posted: 2, skipped: 0, failed: 0 });
    expect(titles).toEqual(["On-chain anchors waiting", "Tally copy needed · Proposal #4"]);
    expect(mocks.stamp).toHaveBeenCalledTimes(2);
    expect(mocks.stamp.mock.calls[0]![0]).toEqual([
      { proposalId: "p-1", step: "proposed", kind: "stale", dueSince: stale.dueSince },
    ]);
    expect(mocks.stamp.mock.calls[1]![0]).toEqual([
      { proposalId: "p-2", step: "closed", kind: "copy_grace", dueSince: grace.dueSince },
    ]);
  });

  it("skips candidates already stamped for the same due_since", async () => {
    mocks.loadCandidates.mockResolvedValue([stale]);
    mocks.loadStamps.mockResolvedValue([{
      proposal_id: "p-1", step: "proposed", kind: "stale",
      due_since: stale.dueSince, alerted_at: "2026-10-03T00:00:00Z",
    }]);
    const fetchImpl = vi.fn();
    expect(await notifyAnchorsDue(NOW, { fetchImpl })).toEqual({ posted: 0, skipped: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.stamp).not.toHaveBeenCalled();
  });

  it("re-posts when due_since changed (a new due episode)", async () => {
    mocks.loadCandidates.mockResolvedValue([stale]);
    mocks.loadStamps.mockResolvedValue([{
      proposal_id: "p-1", step: "proposed", kind: "stale",
      due_since: "2026-08-01T00:00:00.000Z", alerted_at: "2026-08-05T00:00:00Z",
    }]);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await notifyAnchorsDue(NOW, { fetchImpl })).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("leaves candidates for the next run on a transient failure, stamps on a dead webhook", async () => {
    mocks.loadCandidates.mockResolvedValue([stale]);
    const busy = vi.fn(async () => new Response("slow down", { status: 429 }));
    expect(await notifyAnchorsDue(NOW, { fetchImpl: busy })).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(mocks.stamp).not.toHaveBeenCalled();

    mocks.stamp.mockClear();
    const gone = vi.fn(async () => new Response("Unknown Webhook", { status: 404 }));
    expect(await notifyAnchorsDue(NOW, { fetchImpl: gone })).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(mocks.stamp).toHaveBeenCalledTimes(1);
  });
});

describe("stampCurrentAnchorAlerts", () => {
  it("stamps every current candidate without posting", async () => {
    mocks.loadCandidates.mockResolvedValue([stale, grace]);
    await stampCurrentAnchorAlerts("c-1", NOW);
    expect(mocks.loadCandidates).toHaveBeenCalledWith("c-1", NOW.getTime());
    expect(mocks.stamp).toHaveBeenCalledExactlyOnceWith([
      { proposalId: "p-1", step: "proposed", kind: "stale", dueSince: stale.dueSince },
      { proposalId: "p-2", step: "closed", kind: "copy_grace", dueSince: grace.dueSince },
    ]);
  });
});
