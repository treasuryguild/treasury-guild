import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), admin: vi.fn(), community: vi.fn(),
  connect: vi.fn(), load: vi.fn(), remove: vi.fn(), listChannels: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/discord/notifyProposals", () => ({
  connectGovernanceDiscordChannel: mocks.connect,
  loadGovernanceDiscordStatus: mocks.load,
  removeGovernanceDiscordChannel: mocks.remove,
  listGovernanceDiscordChannelOptions: mocks.listChannels,
}));

import { DiscordBotError } from "@/lib/discord/bot";
import { DELETE, GET, POST } from "./route";

const WALLET = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const CHANNEL = "123456789012345678";
const STATUS = {
  serverConnected: true,
  serverLabel: "Guild",
  channelId: CHANNEL,
  channelType: 15,
  lastPostedAt: null,
  lastError: null,
};
const DISCONNECTED = {
  serverConnected: false,
  serverLabel: null,
  channelId: null,
  channelType: null,
  lastPostedAt: null,
  lastError: null,
};
const ROW = { id: COMMUNITY, name: "Signius", slug: "signius" };
const URL_ROUTE = "http://localhost/api/governance/discord";
const context = { params: Promise.resolve({}) };
const send = (handler: typeof POST, method: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(URL_ROUTE, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }), context);
const get = (query: string) => GET(new Request(`${URL_ROUTE}${query}`), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue(undefined);
  mocks.community.mockResolvedValue(ROW);
  mocks.load.mockResolvedValue(STATUS);
  mocks.connect.mockResolvedValue(STATUS);
  mocks.remove.mockResolvedValue(undefined);
  mocks.listChannels.mockResolvedValue([{ id: CHANNEL, name: "proposals", type: 15 }]);
});

function nothingWritten() {
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
}

describe("GET /api/governance/discord", () => {
  it("requires a session, a valid community id and the admin role", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(401);
    expect((await get("")).status).toBe(400);
    expect((await get("?communityId=nope")).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.admin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("returns the discord status", async () => {
    const res = await get(`?communityId=${COMMUNITY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discord: STATUS });
    expect(mocks.load).toHaveBeenCalledWith(COMMUNITY);
    mocks.load.mockResolvedValue(DISCONNECTED);
    expect(await (await get(`?communityId=${COMMUNITY}`)).json()).toEqual({ discord: DISCONNECTED });
  });

  it("includes channel options when channels=1", async () => {
    const res = await get(`?communityId=${COMMUNITY}&channels=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      discord: STATUS,
      channels: [{ id: CHANNEL, name: "proposals", type: 15 }],
    });
    expect(mocks.listChannels).toHaveBeenCalledWith(COMMUNITY);
  });
});

describe("POST /api/governance/discord", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await send(POST, "POST", { communityId: COMMUNITY, channelId: CHANNEL })).status).toBe(401);
    nothingWritten();
  });

  it("refuses a cross-site request", async () => {
    expect((await send(POST, "POST", { communityId: COMMUNITY, channelId: CHANNEL }, { origin: "https://evil.test" })).status).toBe(403);
    nothingWritten();
  });

  it("refuses a bad channel id before checking the role", async () => {
    const invalid = [
      {},
      { communityId: COMMUNITY },
      { communityId: "nope", channelId: CHANNEL },
      { communityId: COMMUNITY, channelId: "not-numeric" },
      { communityId: COMMUNITY, channelId: "" },
    ];
    for (const body of invalid) expect((await send(POST, "POST", body)).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("requires an admin of the community", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await send(POST, "POST", { communityId: COMMUNITY, channelId: CHANNEL })).status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.community).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("answers 404 for a community that does not exist", async () => {
    mocks.community.mockRejectedValue(new NotFoundError("Community not found"));
    expect((await send(POST, "POST", { communityId: COMMUNITY, channelId: CHANNEL })).status).toBe(404);
    nothingWritten();
  });

  it("connects the channel as the session wallet", async () => {
    const res = await send(POST, "POST", { communityId: COMMUNITY, channelId: CHANNEL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discord: STATUS });
    expect(mocks.community).toHaveBeenCalledWith(COMMUNITY);
    expect(mocks.connect).toHaveBeenCalledWith(ROW, CHANNEL, WALLET);
  });

  it("turns a failed Discord call into a 400 with Discord's message", async () => {
    mocks.connect.mockRejectedValue(new DiscordBotError("Discord channel missing or bot lacks permission", 404, true));
    const res = await send(POST, "POST", { communityId: COMMUNITY, channelId: CHANNEL });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Discord channel missing or bot lacks permission" });
  });

  it("lets any other failure through as it is", async () => {
    mocks.connect.mockRejectedValue(new ForbiddenError("nope"));
    expect((await send(POST, "POST", { communityId: COMMUNITY, channelId: CHANNEL })).status).toBe(403);
  });
});

describe("DELETE /api/governance/discord", () => {
  it("requires a session, the same origin, a valid id and the admin role", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await send(DELETE, "DELETE", { communityId: COMMUNITY })).status).toBe(401);
    expect((await send(DELETE, "DELETE", { communityId: COMMUNITY }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await send(DELETE, "DELETE", {})).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.admin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await send(DELETE, "DELETE", { communityId: COMMUNITY })).status).toBe(403);
    nothingWritten();
  });

  it("removes the community's governance channel", async () => {
    const res = await send(DELETE, "DELETE", { communityId: COMMUNITY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.remove).toHaveBeenCalledWith(COMMUNITY);
  });
});
