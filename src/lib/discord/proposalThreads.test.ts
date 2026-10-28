import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbClient from "@/lib/db/client";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  loadChannel: vi.fn(),
  loadGuild: vi.fn(),
  recordError: vi.fn(),
  createForum: vi.fn(),
  postMessage: vi.fn(),
  startThread: vi.fn(),
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
    return Array.isArray(res.data) ? res.data : [];
  },
  check: (res: { error: unknown }, what: string) => {
    if (res.error) throw new Error(what);
  },
  maybe: (res: { data: unknown; error: unknown }, what: string) => {
    if (res.error) throw new Error(what);
    return res.data ?? null;
  },
}));
vi.mock("./governanceChannel", () => ({
  loadGovernanceChannel: mocks.loadChannel,
  loadDiscordGuild: mocks.loadGuild,
  recordGovernanceChannelError: mocks.recordError,
}));
vi.mock("./bot", async (importOriginal) => {
  const real = await importOriginal<typeof import("./bot")>();
  return {
    ...real,
    createForumPost: mocks.createForum,
    postChannelMessage: mocks.postMessage,
    startThreadFromMessage: mocks.startThread,
  };
});

import { ensureProposalDiscordThread } from "./proposalThreads";

const rules = {
  method: "majority", electorate: "members", activityMonths: 12, minMemberDays: 0, quorumPct: 20, thresholdPct: 50,
  lazyObjections: 1, discussionHours: 48, votingHours: 72, hideResults: true, recuseBeneficiaries: false,
};

let proposal: Record<string, unknown>;

function builder(table: string) {
  const chain: Record<string, unknown> = {};
  const respond = () => {
    if (table === "proposals" && chain._op === "update") return { data: null, error: null };
    if (table === "proposals") return { data: proposal, error: null };
    if (table === "communities") return { data: { name: "Guild", slug: "guild" }, error: null };
    return { data: null, error: null };
  };
  Object.assign(chain, {
    _op: "select",
    select: () => chain,
    update: (values: Record<string, unknown>) => { chain._op = "update"; chain._values = values; return chain; },
    eq: () => chain,
    is: () => chain,
    maybeSingle: () => Promise.resolve(respond()),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(respond()).then(resolve, reject),
  });
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.from.mockImplementation(builder);
  mocks.loadChannel.mockResolvedValue({
    community_id: "c-1", channel_id: "chan-1", channel_type: 15,
    created_by: "a", created_at: "2026-01-01", last_posted_at: null, last_error: null,
  });
  mocks.loadGuild.mockResolvedValue({ guildId: "guild-1", label: "Guild" });
  mocks.recordError.mockResolvedValue(undefined);
  proposal = {
    id: "p-1", community_id: "c-1", number: 7, title: "Adopt handbook", kind: "decision",
    rules, discord_thread_id: null, discord_discussion_url: null,
  };
});

describe("ensureProposalDiscordThread", () => {
  it("skips when discussion hours are zero", async () => {
    proposal.rules = { ...rules, discussionHours: 0 };
    expect(await ensureProposalDiscordThread("p-1")).toEqual({ status: "skipped" });
    expect(mocks.createForum).not.toHaveBeenCalled();
  });

  it("skips when a thread already exists", async () => {
    proposal.discord_thread_id = "already";
    expect(await ensureProposalDiscordThread("p-1")).toEqual({ status: "exists" });
  });

  it("creates a forum post and stores the discord URL", async () => {
    mocks.createForum.mockResolvedValue({ id: "thread-7" });
    expect(await ensureProposalDiscordThread("p-1")).toEqual({ status: "created" });
    expect(mocks.createForum).toHaveBeenCalledWith(
      "chan-1",
      expect.objectContaining({ name: expect.stringContaining("#7") }),
      undefined,
    );
    expect(mocks.from).toHaveBeenCalledWith("proposals");
  });

  it("creates a text-channel thread from a parent message", async () => {
    mocks.loadChannel.mockResolvedValue({
      community_id: "c-1", channel_id: "chan-1", channel_type: 0,
      created_by: "a", created_at: "2026-01-01", last_posted_at: null, last_error: null,
    });
    mocks.postMessage.mockResolvedValue({ id: "msg-1", channel_id: "chan-1" });
    mocks.startThread.mockResolvedValue({ id: "msg-1" });
    expect(await ensureProposalDiscordThread("p-1")).toEqual({ status: "created" });
    expect(mocks.postMessage).toHaveBeenCalled();
    expect(mocks.startThread).toHaveBeenCalledWith("chan-1", "msg-1", expect.stringContaining("#7"), undefined);
  });
});
