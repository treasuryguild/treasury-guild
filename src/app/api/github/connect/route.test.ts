import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/errors";
import { verifyOAuthState } from "@/lib/oauth/state";

const mocks = vi.hoisted(() => ({ session: vi.fn(), unlink: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db/github", () => ({ unlinkGithubAccount: mocks.unlink }));
import { DELETE, GET } from "./route";

const WALLET = "addr_test1abc";
const URL_BASE = "https://vault.test/api/github/connect";
const context = { params: Promise.resolve({}) };
const connect = (query = "") => GET(new Request(`${URL_BASE}${query}`), context);
const disconnect = (headers: Record<string, string> = {}) => DELETE(new Request(URL_BASE, { method: "DELETE", headers }), context);

function authorize(response: Response): URL {
  expect(response.status).toBe(307);
  return new URL(response.headers.get("location")!);
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = "test-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.GITHUB_CLIENT_ID = "client-id";
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.unlink.mockResolvedValue(undefined);
});

describe("GET /api/github/connect", () => {
  it("redirects to GitHub with this deployment's callback and a state bound to the wallet", async () => {
    const url = authorize(await connect("?returnTo=/c/demo/settings"));
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "state"]);
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://vault.test/api/github/oauth-callback");
    const state = url.searchParams.get("state")!;
    expect(verifyOAuthState("github-link", state)).toEqual({ wallet: WALLET, returnTo: "/c/demo/settings" });
    expect(verifyOAuthState("github-install", state)).toBeNull();
  });

  it("returns to Settings unless the requested path is an app path", async () => {
    for (const requested of ["", "?returnTo=https://evil.test/x", "?returnTo=//evil.test", "?returnTo=/c/demo?next=//evil.test", "?returnTo=settings"]) {
      const state = authorize(await connect(requested)).searchParams.get("state")!;
      expect(verifyOAuthState("github-link", state)).toEqual({ wallet: WALLET, returnTo: "/settings" });
    }
  });

  it("refuses an oversized return path and a request with no session", async () => {
    expect((await connect(`?returnTo=/${"a".repeat(200)}`)).status).toBe(400);
    mocks.session.mockRejectedValue(new UnauthorizedError());
    const response = await connect();
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("DELETE /api/github/connect", () => {
  it("unlinks the session wallet's GitHub account", async () => {
    const response = await disconnect();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.unlink).toHaveBeenCalledTimes(1);
    expect(mocks.unlink).toHaveBeenCalledWith(WALLET);
  });

  it("refuses a cross-site request and a request with no session", async () => {
    expect((await disconnect({ Origin: "https://evil.test" })).status).toBe(403);
    expect((await disconnect({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await disconnect()).status).toBe(401);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
});
