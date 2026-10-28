import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  redeem: vi.fn(),
  rate: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/invites", () => ({ redeemInvite: mocks.redeem }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));

import { POST } from "./route";

const WALLET = "addr_test1newcomer";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";

const post = (token: string, headers: Record<string, string> = {}) =>
  POST(
    new Request(`http://localhost/api/invites/${token}/redeem`, {
      method: "POST",
      headers,
    }),
    { params: Promise.resolve({ token }) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.rate.mockResolvedValue(undefined);
  mocks.redeem.mockResolvedValue({
    communityId: "10000000-0000-4000-8000-000000000001",
    slug: "demo",
    name: "Demo",
    network: 0,
    already: false,
  });
});

describe("POST /api/invites/[token]/redeem", () => {
  it("joins the session wallet through the invite", async () => {
    const res = await post(TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      slug: "demo",
      name: "Demo",
      already: false,
    });
    expect(mocks.redeem).toHaveBeenCalledExactlyOnceWith(TOKEN, WALLET);
    expect(mocks.rate).toHaveBeenCalledWith("inviteRedeem", WALLET);
  });

  it("requires a session and the same origin", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post(TOKEN)).status).toBe(401);
    expect((await post(TOKEN, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.redeem).not.toHaveBeenCalled();
  });

  it("maps unknown invites and network mismatches", async () => {
    mocks.redeem.mockRejectedValueOnce(new NotFoundError("Invite not found"));
    expect((await post(TOKEN)).status).toBe(404);
    mocks.redeem.mockRejectedValueOnce(
      new BadRequestError("This community runs on preprod: use a preprod (addr_test…) address"),
    );
    expect((await post(TOKEN)).status).toBe(400);
  });
});
