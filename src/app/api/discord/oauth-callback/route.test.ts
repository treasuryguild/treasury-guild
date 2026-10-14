import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signOAuthState, type OAuthPurpose } from "@/lib/oauth/state";

// The personal account link's callback matrix (identityLink.ts), run through
// Discord's route; /api/google/oauth-callback covers what differs. The token
// and profile requests are a stubbed fetch: nothing leaves the process.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), link: vi.fn(), fill: vi.fn(), contributor: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/identities", () => ({
  linkIdentity: mocks.link, fillAttendeeWalletsByIdentity: mocks.fill, unlinkIdentity: vi.fn(),
}));
vi.mock("@/lib/db/membership", () => ({ ensureContributor: mocks.contributor }));
import { GET } from "./route";

const WALLET = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const OTHER = "addr_test1vznqk7fg98mup5ycpd7w9ql62htvh4cwqzugj4x3eqdfyvgtvyz89";
const TOKEN_URL = "https://discord.com/api/oauth2/token";
const USER_URL = "https://discord.com/api/users/@me";

const context = { params: Promise.resolve({}) };
const state = (purpose: OAuthPurpose = "discord-link", payload: object = {}) =>
  signOAuthState(purpose, { wallet: WALLET, returnTo: "/c/demo/calls", ...payload });
const callback = (query: Record<string, string>) =>
  GET(new Request(`https://vault.test/api/discord/oauth-callback?${new URLSearchParams(query)}`), context);
/** Where a callback redirects: the path and the outcome it reports. */
function outcome(response: Response) {
  expect(response.status).toBe(307);
  const url = new URL(response.headers.get("location")!);
  return { origin: url.origin, path: url.pathname, ...Object.fromEntries(url.searchParams) };
}
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
/** Discord's two answers: the token endpoint's, then the user lookup's. */
function discordAnswers(token: Response, user: Response = json({ id: "1234567890", username: "ann", global_name: "Ann" })) {
  mocks.fetch.mockImplementation(async (url: string | URL) => (String(url) === TOKEN_URL ? token : user));
}

beforeAll(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "state-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.DISCORD_CLIENT_ID = "discord-client";
  process.env.DISCORD_CLIENT_SECRET = "discord-secret";
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.contributor.mockResolvedValue({ created: false });
  mocks.link.mockResolvedValue("linked");
  mocks.fill.mockResolvedValue(0);
  discordAnswers(json({ access_token: "discord-access", refresh_token: "discord-refresh", token_type: "Bearer" }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("discord oauth-callback API", () => {
  it("exchanges the code, links the account it proves and returns to where the flow started", async () => {
    const response = await callback({ code: "the-code", state: state() });
    expect(outcome(response)).toEqual({ origin: "https://vault.test", path: "/c/demo/calls", discord: "connected" });

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(TOKEN_URL);
    expect(tokenInit.method).toBe("POST");
    expect(Object.fromEntries(tokenInit.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      client_id: "discord-client",
      client_secret: "discord-secret",
      code: "the-code",
      redirect_uri: "https://vault.test/api/discord/oauth-callback",
    });
    expect(mocks.fetch.mock.calls[1]).toEqual([USER_URL, { headers: { Authorization: "Bearer discord-access" } }]);

    expect(mocks.contributor).toHaveBeenCalledExactlyOnceWith(WALLET);
    // The whole row: the account id and name, and no provider token.
    expect(mocks.link).toHaveBeenCalledExactlyOnceWith({
      wallet: WALLET, provider: "discord", externalId: "1234567890", displayName: "Ann",
    });
    expect(mocks.fill).toHaveBeenCalledExactlyOnceWith("discord", "1234567890", WALLET);
    // The contributor row exists before the identity row that references it.
    expect(mocks.contributor.mock.invocationCallOrder[0]).toBeLessThan(mocks.link.mock.invocationCallOrder[0]!);
  });

  it("names the account by its global name, else its username, else nothing", async () => {
    discordAnswers(json({ access_token: "a" }), json({ id: "1", username: "ann", global_name: null }));
    await callback({ code: "c", state: state() });
    expect(mocks.link).toHaveBeenLastCalledWith(expect.objectContaining({ displayName: "ann" }));
    discordAnswers(json({ access_token: "a" }), json({ id: "1" }));
    await callback({ code: "c", state: state() });
    expect(mocks.link).toHaveBeenLastCalledWith(expect.objectContaining({ externalId: "1", displayName: null }));
  });

  it("reports an account another wallet already holds, without backfilling attendance", async () => {
    mocks.link.mockResolvedValue("taken");
    expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ path: "/c/demo/calls", discord: "taken" });
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  describe("what it refuses before any token exchange", () => {
    const refused = async (query: Record<string, string>, expected: object) => {
      expect(outcome(await callback(query))).toMatchObject(expected);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.link).not.toHaveBeenCalled();
      expect(mocks.contributor).not.toHaveBeenCalled();
    };

    it("refuses a missing or garbage state, returning to Settings", async () => {
      await refused({ code: "c" }, { path: "/settings", discord: "error", reason: "bad_state" });
      await refused({ code: "c", state: "garbage.mac" }, { path: "/settings", discord: "error", reason: "bad_state" });
    });

    it("refuses a forged state: another payload under a real state's signature", async () => {
      const real = state();
      const forged = Buffer.from(JSON.stringify({
        wallet: WALLET, returnTo: "/c/evil", purpose: "discord-link", exp: Date.now() + 600_000,
      })).toString("base64url");
      await refused({ code: "c", state: `${forged}${real.slice(real.lastIndexOf("."))}` }, { path: "/settings", reason: "bad_state" });
    });

    it("refuses a state signed for another flow", async () => {
      for (const purpose of ["google-link", "github-link", "discord-guild", "zoom-host", "google-host"] as const) {
        // Its returnTo is never trusted: the outcome goes to Settings.
        await refused({ code: "c", state: state(purpose, { communityId: "c1" }) }, { path: "/settings", discord: "error", reason: "bad_state" });
      }
    });

    it("refuses a state older than ten minutes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() - 11 * 60_000);
      const stale = state();
      vi.useRealTimers();
      await refused({ code: "c", state: stale }, { path: "/settings", discord: "error", reason: "bad_state" });
    });

    it("reports a declined consent as cancelled and other provider errors as errors", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await refused({ error: "access_denied", state: state() }, { path: "/c/demo/calls", discord: "cancelled", reason: "access_denied" });
      await refused({ error: "invalid_scope", state: state() }, { path: "/c/demo/calls", discord: "error", reason: "invalid_scope" });
    });

    it("refuses a callback without a code", async () => {
      await refused({ state: state() }, { path: "/c/demo/calls", discord: "error", reason: "no_code" });
    });

    it("refuses a callback finished without a session, or by another wallet", async () => {
      mocks.session.mockResolvedValue(null);
      await refused({ code: "c", state: state() }, { discord: "error", reason: "no_session" });
      mocks.session.mockResolvedValue({ wallet: OTHER });
      await refused({ code: "c", state: state() }, { discord: "error", reason: "wallet_mismatch" });
    });
  });

  describe("when Discord does not prove an account", () => {
    const failed = async (reason = "exception") => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(outcome(await callback({ code: "c", state: state() }))).toEqual({
        origin: "https://vault.test", path: "/c/demo/calls", discord: "error", reason,
      });
      expect(logged).toHaveBeenCalled();
      expect(mocks.link).not.toHaveBeenCalled();
      expect(mocks.fill).not.toHaveBeenCalled();
    };

    it("links nothing when the code is refused", async () => {
      discordAnswers(json({ error: "invalid_grant" }, 400));
      await failed();
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it("links nothing when the user lookup fails or names no user", async () => {
      discordAnswers(json({ access_token: "a" }), json({ message: "401: Unauthorized" }, 401));
      await failed();
      discordAnswers(json({ access_token: "a" }), json({ username: "ann" }));
      await failed();
    });

    it("links nothing when the network fails", async () => {
      mocks.fetch.mockRejectedValue(new Error("socket hang up"));
      await failed();
    });

    it("says so when the Discord application is not configured", async () => {
      const secret = process.env.DISCORD_CLIENT_SECRET;
      delete process.env.DISCORD_CLIENT_SECRET;
      try {
        await failed("oauth_env_missing");
        expect(mocks.fetch).not.toHaveBeenCalled();
      } finally {
        process.env.DISCORD_CLIENT_SECRET = secret;
      }
    });
  });
});
