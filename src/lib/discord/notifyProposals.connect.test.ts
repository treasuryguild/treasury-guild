import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbClient from "@/lib/db/client";
import type * as BotModule from "./bot";
import { DiscordBotError } from "./bot";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  guild: vi.fn(),
  loadChannel: vi.fn(),
  upsert: vi.fn(),
  channels: vi.fn(),
  post: vi.fn(),
  stampAnchors: vi.fn(),
}));

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
}));
vi.mock("./governanceChannel", () => ({
  loadDiscordGuild: mocks.guild,
  loadGovernanceChannel: mocks.loadChannel,
  upsertGovernanceChannel: mocks.upsert,
  listGovernanceChannels: vi.fn(),
  recordGovernanceChannelPost: vi.fn(),
  recordGovernanceChannelError: vi.fn(),
  removeGovernanceChannel: vi.fn(),
}));
vi.mock("./bot", async (importOriginal) => ({
  ...(await importOriginal<typeof BotModule>()),
  listTextLikeChannels: mocks.channels,
  postChannelMessage: mocks.post,
}));
vi.mock("./notifyAnchorsDue", () => ({
  stampCurrentAnchorAlerts: mocks.stampAnchors,
  notifyAnchorsDue: vi.fn(),
}));

import { connectGovernanceDiscordChannel } from "./notifyProposals";

const COMMUNITY = { id: "c-1", name: "Guild" };
const RULES = {
  method: "majority", electorate: "members", activityMonths: 12, minMemberDays: 0,
  quorumPct: 20, thresholdPct: 50, lazyObjections: 1, discussionHours: 0,
  votingHours: 120, hideResults: true, recuseBeneficiaries: false,
};

interface Op { table: string; op: "select" | "update"; values?: Record<string, unknown>; filters: [string, unknown][] }
let ops: Op[];
let proposals: unknown[];

function builder(table: string) {
  const op: Op = { table, op: "select", filters: [] };
  const record = (k: string, v: unknown) => { op.filters.push([k, v]); return chain; };
  const respond = () => {
    if (op.op === "update") return { data: null, error: null };
    if (table === "proposals") return { data: proposals, error: null };
    return { data: [], error: null };
  };
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

beforeEach(() => {
  ops = [];
  proposals = [];
  vi.resetAllMocks();
  mocks.from.mockImplementation(builder);
  mocks.guild.mockResolvedValue({ guildId: "guild-1", label: "Guild DAO" });
  mocks.channels.mockResolvedValue([{ id: "chan-1", name: "governance", type: 0 }]);
  mocks.post.mockResolvedValue({ id: "m-1", channel_id: "chan-1" });
  mocks.upsert.mockResolvedValue({
    community_id: "c-1", channel_id: "chan-1", channel_type: 0,
    created_by: "admin", created_at: "2026-10-01T00:00:00Z", last_posted_at: "2026-10-01T00:00:00Z", last_error: null,
  });
  mocks.stampAnchors.mockResolvedValue(undefined);
  mocks.loadChannel.mockResolvedValue({
    community_id: "c-1", channel_id: "chan-1", channel_type: 0,
    created_by: "admin", created_at: "2026-10-01T00:00:00Z", last_posted_at: "2026-10-01T00:00:00Z", last_error: null,
  });
});

describe("connectGovernanceDiscordChannel", () => {
  it("posts a hello, saves the channel, stamps current milestones and anchors without announcing history", async () => {
    proposals = [
      { id: "p-vote", state: "voting", closes_at: "2026-12-01T00:00:00Z", execution_state: null, rules: RULES },
      { id: "p-done", state: "passed", closes_at: "2026-09-01T00:00:00Z", execution_state: "applied", rules: RULES },
      { id: "p-talk", state: "discussion", closes_at: null, execution_state: null, rules: RULES },
    ];
    const status = await connectGovernanceDiscordChannel(COMMUNITY, "chan-1", "admin");
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      "chan-1",
      expect.objectContaining({ embeds: expect.any(Array) }),
      undefined,
    );
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith({
      communityId: "c-1", channelId: "chan-1", channelType: 0, actor: "admin",
    });
    const stamps = ops.filter((o) => o.table === "proposals" && o.op === "update");
    expect(stamps).toEqual(expect.arrayContaining([
      expect.objectContaining({ values: { discord_milestone: "voting" }, filters: [["id", ["p-vote"]]] }),
      expect.objectContaining({ values: { discord_milestone: "closed" }, filters: [["id", ["p-done"]]] }),
      expect.objectContaining({ values: { discord_milestone: "discussion" }, filters: [["id", ["p-talk"]]] }),
    ]));
    expect(mocks.stampAnchors).toHaveBeenCalledExactlyOnceWith("c-1", expect.any(Date));
    // Hello only — no proposal embeds posted on connect.
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(status.channelId).toBe("chan-1");
  });

  it("refuses when the Discord server or channel is missing", async () => {
    mocks.guild.mockResolvedValue(null);
    await expect(connectGovernanceDiscordChannel(COMMUNITY, "chan-1", "admin"))
      .rejects.toThrow(DiscordBotError);
    expect(mocks.upsert).not.toHaveBeenCalled();

    mocks.guild.mockResolvedValue({ guildId: "guild-1", label: null });
    mocks.channels.mockResolvedValue([]);
    await expect(connectGovernanceDiscordChannel(COMMUNITY, "chan-1", "admin"))
      .rejects.toThrow(/not on the connected Discord server/);
  });
});
