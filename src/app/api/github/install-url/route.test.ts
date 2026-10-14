import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { verifyOAuthState } from "@/lib/oauth/state";

const mocks = vi.hoisted(() => ({ session: vi.fn(), requireAdmin: vi.fn(), slug: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db/communities", () => ({ communitySlug: mocks.slug }));
import { GET } from "./route";

const WALLET = "addr_test1abc";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({}) };
const get = (query = `communityId=${COMMUNITY}`) => GET(new Request(`http://localhost/api/github/install-url?${query}`), context);

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = "test-secret";
  process.env.GITHUB_APP_SLUG = "treasury-guild-test";
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.requireAdmin.mockResolvedValue("admin");
  mocks.slug.mockResolvedValue("demo");
});

describe("GET /api/github/install-url", () => {
  it("gives an admin the App's install URL with a state bound to the wallet and community", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).url);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/apps/treasury-guild-test/installations/new");
    expect([...url.searchParams.keys()]).toEqual(["state"]);
    const state = url.searchParams.get("state")!;
    expect(verifyOAuthState("github-install", state)).toEqual({
      wallet: WALLET, returnTo: "/c/demo/settings/github", communityId: COMMUNITY,
    });
    expect(verifyOAuthState("github-link", state)).toBeNull();
    expect(mocks.requireAdmin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.slug).toHaveBeenCalledWith(COMMUNITY);
  });

  it("refuses a malformed community id, a non-admin and no session before signing anything", async () => {
    expect((await get("communityId=nope")).status).toBe(400);
    expect((await get("")).status).toBe(400);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();

    mocks.requireAdmin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    const denied = await get();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Requires admin role" });

    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.slug).not.toHaveBeenCalled();
  });

  it("answers 404 for a community that is gone", async () => {
    mocks.slug.mockRejectedValue(new NotFoundError("Community not found"));
    const response = await get();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Community not found" });
  });
});
