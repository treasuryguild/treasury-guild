import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbClient from "@/lib/db/client";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/env.server", () => ({
  discordBotToken: () => "bot-token",
  appUrl: () => "https://app.example",
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
  maybe: (res: { data: unknown; error: unknown }, what: string) => {
    if (res.error) throw new Error(what);
    return res.data ?? null;
  },
}));

import { notifyProposalMilestones } from "./notifyProposals";

const NOW = new Date("2026-09-29T12:00:00Z");
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
const rules = {
  method: "majority", electorate: "members", activityMonths: 12, minMemberDays: 0, quorumPct: 20, thresholdPct: 50,
  lazyObjections: 1, discussionHours: 0, votingHours: 120, hideResults: true, recuseBeneficiaries: false,
};
const proposal = (id: string, patch: Record<string, unknown>) => ({
  id, community_id: "c-1", number: 1, kind: "decision", title: `Proposal ${id}`, state: "voting", rules,
  voting_starts_at: inDays(-1), closes_at: inDays(4), electorate_size: 5, ballots_cast: 1, tally: null,
  outcome_reason: null, execution_state: null, execution_error: null, end_reason: null, discord_milestone: null,
  discord_thread_id: null, discord_discussion_url: null, ...patch,
});

interface Op { table: string; op: "select" | "update"; values?: Record<string, unknown>; filters: [string, unknown][] }
let ops: Op[];
let proposals: unknown[];

function builder(table: string) {
  const op: Op = { table, op: "select", filters: [] };
  const respond = () => {
    if (op.op === "update") return { data: null, error: null };
    if (table === "governance_discord_channels") {
      return {
        data: [{
          community_id: "c-1", channel_id: "chan-1", channel_type: 0,
          created_by: "addr", created_at: NOW.toISOString(), last_posted_at: null, last_error: null,
        }],
        error: null,
      };
    }
    if (table === "communities") return { data: [{ id: "c-1", name: "Guild", slug: "guild" }], error: null };
    if (table === "proposals") return { data: proposals, error: null };
    return { data: [], error: null };
  };
  const record = (k: string, v: unknown) => { op.filters.push([k, v]); return chain; };
  const chain = {
    select: () => chain,
    update: (values: Record<string, unknown>) => { op.op = "update"; op.values = values; return chain; },
    eq: record, in: record, or: (v: string) => record("or", v), is: record,
    order: () => chain, limit: () => chain, maybeSingle: () => Promise.resolve(respond()),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      ops.push(op);
      return Promise.resolve(respond()).then(resolve, reject);
    },
  };
  return chain;
}

beforeAll(() => {
  process.env.APP_URL = "https://app.example";
  process.env.DISCORD_BOT_TOKEN = "bot-token";
});

beforeEach(() => {
  ops = [];
  mocks.from.mockImplementation(builder);
});

const stamps = () => ops.filter((o) => o.table === "proposals" && o.op === "update")
  .map((o) => [o.filters.find(([k]) => k === "id")?.[1], o.values?.discord_milestone]);

describe("notifyProposalMilestones", () => {
  it("posts each due milestone once and records it", async () => {
    proposals = [
      proposal("p-open", {}),
      proposal("p-done", { state: "rejected", discord_milestone: "voting", closed_at: inDays(0) }),
      proposal("p-quiet", { discord_milestone: "voting" }),
      proposal("p-applying", { state: "passed", execution_state: "pending", discord_milestone: "voting" }),
    ];
    const posted: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)).embeds[0].title);
      return new Response(JSON.stringify({ id: "m-1", channel_id: "chan-1" }), { status: 200 });
    });
    const result = await notifyProposalMilestones(NOW, { fetchImpl });
    expect(result).toEqual({ posted: 2, failed: 0, dead: 0 });
    expect(posted).toEqual(["🗳️ Voting open · Proposal #1 · Decision", "❌ Rejected · Proposal #1 · Decision"]);
    expect(stamps()).toEqual([["p-open", "voting"], ["p-done", "closed"]]);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/channels/chan-1/messages");
  });

  it("leaves a milestone for the next run on a transient failure, skips it on a dead channel", async () => {
    proposals = [proposal("p-open", {})];
    const busy = vi.fn(async () => new Response("slow down", { status: 429 }));
    expect(await notifyProposalMilestones(NOW, { fetchImpl: busy })).toEqual({ posted: 0, failed: 1, dead: 0 });
    expect(stamps()).toEqual([]);

    ops = [];
    const gone = vi.fn(async () => new Response("Unknown Channel", { status: 404 }));
    expect(await notifyProposalMilestones(NOW, { fetchImpl: gone })).toEqual({ posted: 0, failed: 0, dead: 1 });
    expect(stamps()).toEqual([["p-open", "voting"]]);
    const channelError = ops.find((o) => o.table === "governance_discord_channels" && o.op === "update");
    expect(String(channelError?.values?.last_error)).toMatch(/missing or bot lacks permission|404/);
  });
});
