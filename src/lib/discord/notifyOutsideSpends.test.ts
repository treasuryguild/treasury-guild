import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnalertedSpend } from "@/lib/db/outsideSpends";
import type * as BotModule from "./bot";
import { DiscordBotError } from "./bot";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  mark: vi.fn(),
  settings: vi.fn(),
  registry: vi.fn(),
  channels: vi.fn(),
  communities: vi.fn(),
  post: vi.fn(),
  recordPost: vi.fn(),
  recordError: vi.fn(),
}));

vi.mock("@/lib/db/outsideSpends", () => ({
  listUnalertedSpends: mocks.list,
  markSpendAlerted: mocks.mark,
}));
vi.mock("@/lib/db/governance", () => ({ loadGovernanceSettings: mocks.settings }));
vi.mock("@/lib/db/assets", () => ({ loadAssetRegistry: mocks.registry }));
vi.mock("@/lib/db/client", () => ({
  serviceClient: () => ({ from: () => ({ select: () => ({ in: () => mocks.communities() }) }) }),
  rows: (res: { data: unknown }) => res.data ?? [],
}));
vi.mock("./governanceChannel", () => ({
  listGovernanceChannelsFor: mocks.channels,
  recordGovernanceChannelPost: mocks.recordPost,
  recordGovernanceChannelError: mocks.recordError,
}));
vi.mock("./bot", async (importOriginal) => ({
  ...(await importOriginal<typeof BotModule>()),
  postChannelMessage: mocks.post,
}));

import { notifyOutsideSpends } from "./notifyOutsideSpends";

const TX = "a".repeat(64);
const CHANNEL = {
  community_id: "c-1", channel_id: "chan-1", channel_type: 0 as const,
  created_by: "addr", created_at: "2026-10-01T00:00:00Z", last_posted_at: null, last_error: null,
};

function spend(patch: Partial<UnalertedSpend> = {}): UnalertedSpend {
  return {
    tx_hash: TX,
    treasury_id: "t-1",
    block_time: "2026-10-01T12:00:00Z",
    amount_lovelace: "5000000",
    assets: null,
    to_addresses: ["addr_test1bob"],
    to_treasury_id: null,
    treasuries: { name: "Main", network: 0, community_id: "c-1" },
    ...patch,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.list.mockResolvedValue([spend()]);
  mocks.mark.mockResolvedValue(undefined);
  mocks.settings.mockResolvedValue({ enabled: true });
  mocks.registry.mockResolvedValue([]);
  mocks.channels.mockResolvedValue([CHANNEL]);
  mocks.communities.mockResolvedValue({ data: [{ id: "c-1", name: "Guild" }], error: null });
  mocks.post.mockResolvedValue({ id: "m-1", channel_id: "chan-1" });
  mocks.recordPost.mockResolvedValue(undefined);
  mocks.recordError.mockResolvedValue(undefined);
});

describe("notifyOutsideSpends", () => {
  it("does nothing when nothing is waiting", async () => {
    mocks.list.mockResolvedValue([]);
    expect(await notifyOutsideSpends()).toEqual({ posted: 0, skipped: 0, failed: 0 });
    expect(mocks.channels).not.toHaveBeenCalled();
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it("stamps without posting when the budget kind is off", async () => {
    mocks.settings.mockResolvedValue({ enabled: false });
    expect(await notifyOutsideSpends()).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(mocks.mark).toHaveBeenCalledExactlyOnceWith([TX]);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.recordPost).not.toHaveBeenCalled();
  });

  it("stamps without posting when there is no governance channel", async () => {
    mocks.channels.mockResolvedValue([]);
    expect(await notifyOutsideSpends()).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(mocks.mark).toHaveBeenCalledExactlyOnceWith([TX]);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("posts once, stamps the spend and records the channel post", async () => {
    expect(await notifyOutsideSpends()).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      "chan-1",
      expect.objectContaining({ embeds: expect.any(Array) }),
      undefined,
    );
    expect(mocks.mark).toHaveBeenCalledExactlyOnceWith([TX]);
    expect(mocks.recordPost).toHaveBeenCalledExactlyOnceWith("c-1");
    expect(mocks.settings).toHaveBeenCalledExactlyOnceWith("c-1", "budget");
  });

  it("leaves the spend for the next run on a transient bot failure", async () => {
    mocks.post.mockRejectedValue(new DiscordBotError("slow down", 429, false));
    expect(await notifyOutsideSpends()).toEqual({ posted: 0, skipped: 0, failed: 1 });
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(mocks.recordError).not.toHaveBeenCalled();
  });

  it("stamps and records the channel error when the channel is permanently gone", async () => {
    mocks.post.mockRejectedValue(new DiscordBotError("Unknown Channel", 404, true));
    expect(await notifyOutsideSpends()).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(mocks.mark).toHaveBeenCalledExactlyOnceWith([TX]);
    expect(mocks.recordError).toHaveBeenCalledExactlyOnceWith("c-1", "Unknown Channel");
    expect(mocks.recordPost).not.toHaveBeenCalled();
  });

  it("only announces what listUnalertedSpends returns (open imports never reach here)", async () => {
    mocks.list.mockResolvedValue([]);
    expect(await notifyOutsideSpends()).toEqual({ posted: 0, skipped: 0, failed: 0 });
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
