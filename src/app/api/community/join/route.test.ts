import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), community: vi.fn(), add: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/db/membership", () => ({ addMember: mocks.add }));
import { POST } from "./route";

const WALLET = "addr_test1newcomer";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const post = (body: object, headers: Record<string, string> = {}) => POST(new Request("http://localhost/api/community/join", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
}), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.community.mockResolvedValue({ id: COMMUNITY, slug: "signius", visibility: "public" });
  mocks.add.mockResolvedValue(undefined);
});

describe("POST /api/community/join", () => {
  it("joins the session wallet to a public community as a plain member", async () => {
    const res = await post({ communityId: COMMUNITY, wallet: "addr_test1someoneelse", role: "admin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slug: "signius" });
    expect(mocks.community).toHaveBeenCalledWith(COMMUNITY);
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith(COMMUNITY, WALLET);
  });

  it("refuses a private community: it is joined by invitation only", async () => {
    mocks.community.mockResolvedValue({ id: COMMUNITY, slug: "signius", visibility: "private" });
    const res = await post({ communityId: COMMUNITY });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This community is invite-only" });
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("requires a session, the same origin and a well-formed id", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post({ communityId: COMMUNITY })).status).toBe(401);
    expect((await post({ communityId: COMMUNITY }, { origin: "https://evil.test" })).status).toBe(403);
    expect((await post({})).status).toBe(400);
    expect((await post({ communityId: "signius" })).status).toBe(400);
    expect(mocks.community).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("answers 404 for a community that does not exist", async () => {
    mocks.community.mockRejectedValue(new NotFoundError("Community not found"));
    expect((await post({ communityId: COMMUNITY })).status).toBe(404);
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
