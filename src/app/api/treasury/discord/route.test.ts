import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WebhookModule from "@/lib/discord/webhook";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  treasuryAdmin: vi.fn(),
  list: vi.fn(),
  saveWebhook: vi.fn(),
  remove: vi.fn(),
  post: vi.fn(),
  connectChannel: vi.fn(),
  listChannels: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin, requireTreasuryAdmin: mocks.treasuryAdmin }));
vi.mock("@/lib/db/treasuries", () => ({
  listTreasuryDiscordDestinations: mocks.list,
  saveTreasuryDiscordWebhook: mocks.saveWebhook,
  deleteTreasuryDiscordDestination: mocks.remove,
}));
vi.mock("@/lib/discord/webhook", async (importOriginal) => ({
  ...(await importOriginal<typeof WebhookModule>()),
  postDiscordWebhook: mocks.post,
}));
vi.mock("@/lib/discord/treasuryDestination", () => ({
  connectTreasuryDiscordChannel: mocks.connectChannel,
  listTreasuryDiscordChannelOptions: mocks.listChannels,
}));
import { buildConnectedEmbed } from "@/lib/discord/payoutMessage";
import { DiscordBotError } from "@/lib/discord/bot";
import { DiscordWebhookError } from "@/lib/discord/webhook";
import { DELETE, GET, POST } from "./route";

const WALLET = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const TREASURY = "40000000-0000-4000-8000-000000000001";
const OTHER = "40000000-0000-4000-8000-000000000002";
const HOOK = "https://discord.com/api/webhooks/123456789/AbC-dEf_123";
const HINT = "…/webhooks/123456789/••••_123";
const CHANNEL = "987654321012345678";
const URL_ROUTE = "http://localhost/api/treasury/discord";
const context = { params: Promise.resolve({}) };
const send = (handler: typeof POST, method: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(URL_ROUTE, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }), context);
const get = (query: string) => GET(new Request(`${URL_ROUTE}${query}`), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue("admin");
  mocks.treasuryAdmin.mockResolvedValue({
    id: TREASURY,
    community_id: COMMUNITY,
    name: "Main treasury",
  });
  mocks.list.mockResolvedValue([]);
  mocks.post.mockResolvedValue(undefined);
  mocks.saveWebhook.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.connectChannel.mockResolvedValue({
    now: "2026-09-01T10:00:00.000Z",
    destination: {
      treasury_id: TREASURY,
      url: null,
      channel_id: CHANNEL,
      channel_type: 0,
      last_posted_at: "2026-09-01T10:00:00.000Z",
      last_error: null,
    },
  });
  mocks.listChannels.mockResolvedValue([{ id: CHANNEL, name: "payouts", type: 0 }]);
});

function nothingWritten() {
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.saveWebhook).not.toHaveBeenCalled();
  expect(mocks.connectChannel).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
}

describe("GET /api/treasury/discord", () => {
  it("requires a session, a valid community id and the admin role", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(401);
    expect((await get("")).status).toBe(400);
    expect((await get("?communityId=nope")).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.admin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("lists each destination without ever returning a webhook URL", async () => {
    mocks.list.mockResolvedValue([
      {
        treasury_id: TREASURY,
        url: HOOK,
        channel_id: null,
        channel_type: null,
        last_posted_at: "2026-09-01T10:00:00.000Z",
        last_error: null,
      },
      {
        treasury_id: OTHER,
        url: null,
        channel_id: CHANNEL,
        channel_type: 5,
        last_posted_at: null,
        last_error: "Discord channel missing or bot lacks permission",
      },
    ]);
    const res = await get(`?communityId=${COMMUNITY}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      destinations: [
        {
          treasuryId: TREASURY,
          mode: "webhook",
          urlHint: HINT,
          lastPostedAt: "2026-09-01T10:00:00.000Z",
          lastError: null,
        },
        {
          treasuryId: OTHER,
          mode: "channel",
          channelId: CHANNEL,
          channelType: 5,
          lastPostedAt: null,
          lastError: "Discord channel missing or bot lacks permission",
        },
      ],
    });
    expect(text).not.toContain("AbC-dEf");
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(COMMUNITY);
  });

  it("includes channel options when asked", async () => {
    const res = await get(`?communityId=${COMMUNITY}&channels=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      destinations: [],
      channels: [{ id: CHANNEL, name: "payouts", type: 0 }],
    });
    expect(mocks.listChannels).toHaveBeenCalledExactlyOnceWith(COMMUNITY);
  });

  it("maps a bot list failure to 400", async () => {
    mocks.listChannels.mockRejectedValue(new DiscordBotError("bot out", null, true));
    const res = await get(`?communityId=${COMMUNITY}&channels=1`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bot out" });
  });
});

describe("POST /api/treasury/discord", () => {
  it("requires a session and the same origin", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await send(POST, "POST", { treasuryId: TREASURY, url: HOOK })).status).toBe(401);
    expect((await send(POST, "POST", { treasuryId: TREASURY, url: HOOK }, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.treasuryAdmin).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("refuses a body that is neither a webhook URL nor a channel id", async () => {
    const invalid = [
      {},
      { treasuryId: TREASURY },
      { treasuryId: "nope", url: HOOK },
      { treasuryId: TREASURY, url: "https://evil.example/api/webhooks/1/x" },
      { treasuryId: TREASURY, url: "http://discord.com/api/webhooks/1/x" },
      { treasuryId: TREASURY, url: `${HOOK}?wait=true` },
      { treasuryId: TREASURY, url: "https://discord.com.evil.example/api/webhooks/1/x" },
      { treasuryId: TREASURY, channelId: "not-digits" },
      { treasuryId: TREASURY, url: HOOK, channelId: CHANNEL },
    ];
    for (const body of invalid) expect((await send(POST, "POST", body)).status).toBe(400);
    expect(mocks.treasuryAdmin).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("requires an admin of the treasury's community, and a treasury that exists", async () => {
    mocks.treasuryAdmin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await send(POST, "POST", { treasuryId: TREASURY, url: HOOK })).status).toBe(403);
    expect(mocks.treasuryAdmin).toHaveBeenCalledWith(TREASURY, WALLET);
    mocks.treasuryAdmin.mockRejectedValueOnce(new NotFoundError("Treasury not found"));
    expect((await send(POST, "POST", { treasuryId: TREASURY, url: HOOK })).status).toBe(404);
    nothingWritten();
  });

  it("posts the hello message, then stores the URL as the session wallet and returns only the hint", async () => {
    const res = await send(POST, "POST", { treasuryId: TREASURY, url: `  ${HOOK}  ` });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("AbC-dEf");
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(HOOK, buildConnectedEmbed("Main treasury"));
    expect(mocks.saveWebhook).toHaveBeenCalledExactlyOnceWith({
      treasuryId: TREASURY,
      url: HOOK,
      actor: WALLET,
      now: expect.any(String),
    });
    expect(mocks.post.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveWebhook.mock.invocationCallOrder[0]!);
    const { now } = mocks.saveWebhook.mock.calls[0]![0] as { now: string };
    expect(new Date(now).toISOString()).toBe(now);
    expect(JSON.parse(text)).toEqual({
      destination: {
        treasuryId: TREASURY,
        mode: "webhook",
        urlHint: HINT,
        lastPostedAt: now,
        lastError: null,
      },
    });
    expect(mocks.connectChannel).not.toHaveBeenCalled();
  });

  it("stores nothing when Discord refuses the webhook test post, and answers 400 with its reason", async () => {
    mocks.post.mockRejectedValue(new DiscordWebhookError("Discord webhook not found (deleted or wrong URL?)", 404, true));
    const res = await send(POST, "POST", { treasuryId: TREASURY, url: HOOK });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Discord webhook not found (deleted or wrong URL?)" });
    expect(mocks.saveWebhook).not.toHaveBeenCalled();
  });

  it("lets any other failure of the webhook test post through as it is, still storing nothing", async () => {
    mocks.post.mockRejectedValue(new ForbiddenError("nope"));
    expect((await send(POST, "POST", { treasuryId: TREASURY, url: HOOK })).status).toBe(403);
    expect(mocks.saveWebhook).not.toHaveBeenCalled();
  });

  it("connects a channel destination through the bot helper", async () => {
    const res = await send(POST, "POST", { treasuryId: TREASURY, channelId: CHANNEL });
    expect(res.status).toBe(200);
    expect(mocks.connectChannel).toHaveBeenCalledExactlyOnceWith(
      { id: TREASURY, community_id: COMMUNITY, name: "Main treasury" },
      CHANNEL,
      WALLET,
    );
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.saveWebhook).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      destination: {
        treasuryId: TREASURY,
        mode: "channel",
        channelId: CHANNEL,
        channelType: 0,
        lastPostedAt: "2026-09-01T10:00:00.000Z",
        lastError: null,
      },
    });
  });

  it("maps a bot connect failure to 400", async () => {
    mocks.connectChannel.mockRejectedValue(
      new DiscordBotError("Connect a Discord server under Integrations first", null, true),
    );
    const res = await send(POST, "POST", { treasuryId: TREASURY, channelId: CHANNEL });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Connect a Discord server under Integrations first" });
  });
});

describe("DELETE /api/treasury/discord", () => {
  it("requires a session, the same origin, a valid id and the admin role", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await send(DELETE, "DELETE", { treasuryId: TREASURY })).status).toBe(401);
    expect((await send(DELETE, "DELETE", { treasuryId: TREASURY }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await send(DELETE, "DELETE", {})).status).toBe(400);
    expect((await send(DELETE, "DELETE", { treasuryId: "nope" })).status).toBe(400);
    expect(mocks.treasuryAdmin).not.toHaveBeenCalled();
    mocks.treasuryAdmin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await send(DELETE, "DELETE", { treasuryId: TREASURY })).status).toBe(403);
    mocks.treasuryAdmin.mockRejectedValueOnce(new NotFoundError("Treasury not found"));
    expect((await send(DELETE, "DELETE", { treasuryId: TREASURY })).status).toBe(404);
    nothingWritten();
  });

  it("removes the treasury's destination without posting anything", async () => {
    const res = await send(DELETE, "DELETE", { treasuryId: TREASURY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.treasuryAdmin).toHaveBeenCalledWith(TREASURY, WALLET);
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(TREASURY);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
