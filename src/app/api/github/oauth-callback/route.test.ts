import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signOAuthState } from "@/lib/oauth/state";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), link: vi.fn(), fill: vi.fn(), autoJoin: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/db/github", () => ({ linkGithubAccount: mocks.link }));
vi.mock("@/lib/db/taskAssignees", () => ({ fillAssigneeWalletsByLogin: mocks.fill }));
vi.mock("@/lib/db/membership", () => ({ autoJoinCommunitiesForGithubLogin: mocks.autoJoin }));
import { GET } from "./route";

const WALLET = "addr_test1abc";
const RETURN_TO = "/c/demo/settings";
const context = { params: Promise.resolve({}) };

const state = (wallet = WALLET) => signOAuthState("github-link", { wallet, returnTo: RETURN_TO });
const callback = (query: Record<string, string>) =>
  GET(new Request(`https://vault.test/api/github/oauth-callback?${new URLSearchParams(query)}`), context);
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });

function outcome(response: Response): { path: string; query: Record<string, string> } {
  expect(response.status).toBe(307);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin).toBe("https://vault.test");
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.CRON_SECRET = "test-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.GITHUB_CLIENT_ID = "client-id";
  process.env.GITHUB_CLIENT_SECRET = "client-secret";
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.fetch.mockImplementation(async (url: string) => url === "https://api.github.com/user"
    ? json({ login: "alice", id: 4242 })
    : json({ access_token: "gho_token" }));
  mocks.link.mockResolvedValue("linked");
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/github/oauth-callback", () => {
  it("exchanges the code as JSON, links the account, backfills assignee wallets and auto-joins", async () => {
    const response = await callback({ code: "the-code", state: state() });
    expect(outcome(response)).toEqual({ path: RETURN_TO, query: { github: "connected" } });

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = mocks.fetch.mock.calls[0]!;
    expect(tokenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(tokenInit).toMatchObject({
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    });
    expect(JSON.parse(tokenInit.body)).toEqual({
      client_id: "client-id", client_secret: "client-secret", code: "the-code",
      redirect_uri: "https://vault.test/api/github/oauth-callback",
    });
    expect(mocks.fetch.mock.calls[1]).toEqual(["https://api.github.com/user", {
      headers: { Authorization: "Bearer gho_token", Accept: "application/vnd.github+json" },
    }]);

    expect(mocks.link).toHaveBeenCalledWith(WALLET, { login: "alice", id: 4242 });
    expect(mocks.fill).toHaveBeenCalledWith("alice", WALLET);
    expect(mocks.autoJoin).toHaveBeenCalledWith(WALLET, "alice");
  });

  describe("what it refuses before any token request", () => {
    const refused = async (query: Record<string, string>) => {
      const result = outcome(await callback(query));
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.link).not.toHaveBeenCalled();
      return result;
    };

    it("reports a declined consent as cancelled and other provider errors as errors", async () => {
      expect(await refused({ error: "access_denied", state: state() })).toEqual({
        path: RETURN_TO, query: { github: "cancelled", reason: "access_denied" },
      });
      expect(await refused({ error: "redirect_uri_mismatch", state: state() })).toEqual({
        path: RETURN_TO, query: { github: "error", reason: "redirect_uri_mismatch" },
      });
    });

    it("needs a code", async () => {
      expect(await refused({ state: state() })).toEqual({ path: RETURN_TO, query: { github: "error", reason: "no_code" } });
    });

    it("accepts only its own signed state, returning to Settings otherwise", async () => {
      const bad = { path: "/settings", query: { github: "error", reason: "bad_state" } };
      expect(await refused({ code: "the-code" })).toEqual(bad);
      expect(await refused({ code: "the-code", state: "garbage.mac" })).toEqual(bad);
      const [body] = state().split(".");
      expect(await refused({ code: "the-code", state: `${body}.${"0".repeat(64)}` })).toEqual(bad);
      const install = signOAuthState("github-install", { wallet: WALLET, returnTo: RETURN_TO, communityId: "c1" });
      expect(await refused({ code: "the-code", state: install })).toEqual(bad);
      const discord = signOAuthState("discord-link", { wallet: WALLET, returnTo: RETURN_TO });
      expect(await refused({ code: "the-code", state: discord })).toEqual(bad);
    });

    it("needs the session of the wallet that started the flow", async () => {
      mocks.session.mockResolvedValue(null);
      expect((await refused({ code: "the-code", state: state() })).query).toEqual({ github: "error", reason: "no_session" });
      mocks.session.mockResolvedValue({ wallet: "addr_test1other" });
      expect((await refused({ code: "the-code", state: state() })).query).toEqual({ github: "error", reason: "wallet_mismatch" });
    });
  });

  describe("GitHub failures", () => {
    const failed = async (reason: string) => {
      const response = await callback({ code: "the-code", state: state() });
      expect(outcome(response)).toEqual({ path: RETURN_TO, query: { github: "error", reason } });
      expect(mocks.link).not.toHaveBeenCalled();
      expect(mocks.fill).not.toHaveBeenCalled();
      expect(mocks.autoJoin).not.toHaveBeenCalled();
    };

    it("reports GitHub's own token error, or a generic one, without fetching the user", async () => {
      mocks.fetch.mockResolvedValueOnce(json({ error: "bad_verification_code", error_description: "The code is incorrect or expired." }));
      await failed("bad_verification_code");
      mocks.fetch.mockResolvedValueOnce(json({}));
      await failed("token_exchange");
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });

    it("reports a failed or incomplete user lookup", async () => {
      mocks.fetch.mockResolvedValueOnce(json({ access_token: "gho_token" })).mockResolvedValueOnce(json({ message: "Bad credentials" }, 401));
      await failed("user_fetch_401");
      mocks.fetch.mockResolvedValueOnce(json({ access_token: "gho_token" })).mockResolvedValueOnce(json({ login: "alice" }));
      await failed("user_incomplete");
      mocks.fetch.mockResolvedValueOnce(json({ access_token: "gho_token" })).mockResolvedValueOnce(json({ id: 4242 }));
      await failed("user_incomplete");
    });

    it("reports a network failure and a non-JSON answer as an exception", async () => {
      mocks.fetch.mockRejectedValueOnce(new Error("socket hang up"));
      await failed("exception");
      mocks.fetch.mockResolvedValueOnce(new Response("<html>502</html>", { status: 502 }));
      await failed("exception");
    });

    it("reports missing OAuth credentials without sending anything", async () => {
      delete process.env.GITHUB_CLIENT_SECRET;
      await failed("oauth_env_missing");
      expect(mocks.fetch).not.toHaveBeenCalled();
    });
  });

  describe("linking", () => {
    it("reports an account another wallet holds, and neither backfills nor joins", async () => {
      mocks.link.mockResolvedValue("taken");
      const response = await callback({ code: "the-code", state: state() });
      expect(outcome(response)).toEqual({ path: RETURN_TO, query: { github: "taken" } });
      expect(mocks.fill).not.toHaveBeenCalled();
      expect(mocks.autoJoin).not.toHaveBeenCalled();
    });

    it("reports a database failure as an exception", async () => {
      mocks.link.mockRejectedValue(new Error("link github: connection refused"));
      const response = await callback({ code: "the-code", state: state() });
      expect(outcome(response)).toEqual({ path: RETURN_TO, query: { github: "error", reason: "exception" } });
      expect(mocks.autoJoin).not.toHaveBeenCalled();
    });
  });
});
