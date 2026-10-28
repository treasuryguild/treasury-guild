import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  rate: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/invites", () => ({
  createInvite: mocks.create,
  listInvites: mocks.list,
  revokeInvite: mocks.revoke,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/env.server", () => ({ appUrl: () => "https://app.test" }));

import { DELETE, GET, POST } from "./route";

const WALLET = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const INVITE_ID = "20000000-0000-4000-8000-000000000001";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";

const inviteRow = {
  id: INVITE_ID,
  community_id: COMMUNITY,
  created_by: WALLET,
  created_at: "2026-10-28T12:00:00.000Z",
  expires_at: "2026-11-27T12:00:00.000Z",
  max_uses: 10,
  use_count: 0,
  last_used_at: null,
  revoked_at: null,
  label: "Discord",
};

const get = (query: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/api/community/invites?${query}`, { headers }), {
    params: Promise.resolve({}),
  });
const post = (body: object, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/api/community/invites", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...headers },
    }),
    { params: Promise.resolve({}) },
  );
const del = (body: object, headers: Record<string, string> = {}) =>
  DELETE(
    new Request("http://localhost/api/community/invites", {
      method: "DELETE",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...headers },
    }),
    { params: Promise.resolve({}) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue(undefined);
  mocks.rate.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([inviteRow]);
  mocks.create.mockResolvedValue({ invite: inviteRow, token: TOKEN });
  mocks.revoke.mockResolvedValue(undefined);
});

describe("GET /api/community/invites", () => {
  it("lists invites for an admin without token hashes", async () => {
    const res = await get(`communityId=${COMMUNITY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      invites: [
        {
          id: INVITE_ID,
          communityId: COMMUNITY,
          createdBy: WALLET,
          createdAt: inviteRow.created_at,
          expiresAt: inviteRow.expires_at,
          maxUses: 10,
          useCount: 0,
          lastUsedAt: null,
          revokedAt: null,
          label: "Discord",
        },
      ],
    });
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
  });

  it("requires a session and admin", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await get(`communityId=${COMMUNITY}`)).status).toBe(401);
    mocks.admin.mockRejectedValueOnce(new ForbiddenError("Admin access required"));
    expect((await get(`communityId=${COMMUNITY}`)).status).toBe(403);
  });
});

describe("POST /api/community/invites", () => {
  it("creates an invite and returns the share URL once", async () => {
    const res = await post({ communityId: COMMUNITY, expiresInDays: 30, maxUses: 10, label: "Discord" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe(`https://app.test/invite/${TOKEN}`);
    expect(body.invite.id).toBe(INVITE_ID);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      communityId: COMMUNITY,
      createdBy: WALLET,
      expiresInDays: 30,
      maxUses: 10,
      label: "Discord",
    });
    expect(mocks.rate).toHaveBeenCalledWith("inviteCreate", WALLET);
  });

  it("defaults expiry to 30 days and max uses to unlimited", async () => {
    await post({ communityId: COMMUNITY });
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      communityId: COMMUNITY,
      createdBy: WALLET,
      expiresInDays: 30,
      maxUses: null,
      label: null,
    });
  });

  it("surfaces the active-invite cap as a 400", async () => {
    mocks.create.mockRejectedValueOnce(
      new BadRequestError("This community already has 20 active invite links. Revoke one first."),
    );
    const res = await post({ communityId: COMMUNITY, expiresInDays: 30 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "This community already has 20 active invite links. Revoke one first.",
    });
  });
});

describe("DELETE /api/community/invites", () => {
  it("revokes an invite in the community", async () => {
    const res = await del({ communityId: COMMUNITY, inviteId: INVITE_ID });
    expect(res.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(INVITE_ID, COMMUNITY);
  });
});
