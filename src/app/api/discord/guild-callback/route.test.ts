import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signOAuthState, type OAuthPurpose } from "@/lib/oauth/state";

// A community host connection's callback matrix (hostLink.ts), run through
// the Discord server's route; /api/zoom/oauth-callback and
// /api/google/host-callback cover what differs. Discord's token endpoint is a
// stubbed fetch: nothing leaves the process.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), role: vi.fn(), save: vi.fn(), saveSecrets: vi.fn(), fetch: vi.fn(),
  load: vi.fn(), elsewhere: vi.fn(), leave: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role, requireAdmin: vi.fn() }));
vi.mock("@/lib/db/callCapture", () => ({
  saveIntegration: mocks.save, saveIntegrationSecrets: mocks.saveSecrets,
  loadIntegration: mocks.load, loadIntegrationSecrets: vi.fn(), deleteIntegration: vi.fn(), accountConnectedElsewhere: mocks.elsewhere,
}));
vi.mock("@/lib/discord/bot", () => ({ leaveGuild: mocks.leave }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: vi.fn() }));
import { GET } from "./route";

const WALLET = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const OTHER = "addr_test1vznqk7fg98mup5ycpd7w9ql62htvh4cwqzugj4x3eqdfyvgtvyz89";
const COMMUNITY_ID = "30000000-0000-4000-8000-000000000001";
const RETURN_TO = "/c/demo/settings/integrations";

const context = { params: Promise.resolve({}) };
const state = (purpose: OAuthPurpose = "discord-guild", payload: object = { communityId: COMMUNITY_ID }) =>
  signOAuthState(purpose, { wallet: WALLET, returnTo: RETURN_TO, ...payload });
const callback = (query: Record<string, string>) =>
  GET(new Request(`https://vault.test/api/discord/guild-callback?${new URLSearchParams(query)}`), context);
/** Where a callback redirects: the path and the outcome it reports. */
function outcome(response: Response) {
  expect(response.status).toBe(307);
  const url = new URL(response.headers.get("location")!);
  return { origin: url.origin, path: url.pathname, ...Object.fromEntries(url.searchParams) };
}
const discordAnswers = (body: object, status = 200) =>
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify(body), { status }));

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
  mocks.role.mockResolvedValue("admin");
  mocks.save.mockResolvedValue({ id: "int-1" });
  mocks.load.mockResolvedValue(null);
  mocks.elsewhere.mockResolvedValue(false);
  mocks.leave.mockResolvedValue(undefined);
  discordAnswers({ access_token: "discord-access", refresh_token: "discord-refresh", guild: { id: "guild-1", name: "Signius HQ" } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("discord guild-callback API", () => {
  it("saves the server Discord's token response names, and returns to where the flow started", async () => {
    const response = await callback({ code: "the-code", state: state() });
    expect(outcome(response)).toEqual({ origin: "https://vault.test", path: RETURN_TO, discord_server: "connected" });

    expect(mocks.role).toHaveBeenCalledExactlyOnceWith(COMMUNITY_ID, WALLET);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/oauth2/token");
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      client_id: "discord-client",
      client_secret: "discord-secret",
      code: "the-code",
      redirect_uri: "https://vault.test/api/discord/guild-callback",
    });
    // The bot token is the application's own: this grant's tokens are not kept.
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      community_id: COMMUNITY_ID, provider: "discord", external_account_id: "guild-1", label: "Signius HQ", created_by: WALLET,
    }, null);
    expect(mocks.saveSecrets).not.toHaveBeenCalled();
    expect(mocks.leave).not.toHaveBeenCalled();
  });

  it("never takes the server id from the query string", async () => {
    await callback({ code: "c", state: state(), guild_id: "someone-elses-guild" });
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ external_account_id: "guild-1" }), null);

    mocks.save.mockClear();
    discordAnswers({ access_token: "a" });
    expect(outcome(await callback({ code: "c", state: state(), guild_id: "someone-elses-guild" })))
      .toMatchObject({ path: RETURN_TO, discord_server: "error", reason: "no_server" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves a server without a name under a null label", async () => {
    discordAnswers({ access_token: "a", guild: { id: "guild-2" } });
    await callback({ code: "c", state: state() });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ external_account_id: "guild-2", label: null }), null);
  });

  it("lets an owner finish as well, and connects for the community the state names", async () => {
    mocks.role.mockResolvedValue("owner");
    expect(outcome(await callback({ code: "c", state: state(), communityId: "40000000-0000-4000-8000-000000000009" })))
      .toMatchObject({ discord_server: "connected" });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ community_id: COMMUNITY_ID }), null);
  });

  describe("re-pointing to another server", () => {
    const previous = { id: "int-1", community_id: COMMUNITY_ID, provider: "discord", external_account_id: "guild-old", label: "Old" };

    it("takes the bot out of the old server once the new one is saved", async () => {
      mocks.load.mockResolvedValue(previous);
      expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ discord_server: "connected" });
      expect(mocks.load).toHaveBeenCalledWith(COMMUNITY_ID, "discord");
      expect(mocks.elsewhere).toHaveBeenCalledWith("discord", "guild-old");
      expect(mocks.leave).toHaveBeenCalledExactlyOnceWith("guild-old");
      expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.leave.mock.invocationCallOrder[0]!);
    });

    it("leaves the bot where another community still uses the old server, and stays for a reconnect to the same one", async () => {
      mocks.load.mockResolvedValue(previous);
      mocks.elsewhere.mockResolvedValue(true);
      await callback({ code: "c", state: state() });
      mocks.load.mockResolvedValue({ ...previous, external_account_id: "guild-1" });
      await callback({ code: "c", state: state() });
      expect(mocks.leave).not.toHaveBeenCalled();
    });

    it("still reports connected when leaving the old server fails", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mocks.load.mockResolvedValue(previous);
      mocks.leave.mockRejectedValue(new Error("Discord 500"));
      expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ discord_server: "connected" });
      expect(logged).toHaveBeenCalled();
    });
  });

  it("takes the bot back out of a server whose connection could not be saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.save.mockRejectedValue(new Error("save call integration: db down"));
    expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ discord_server: "error", reason: "exception" });
    expect(mocks.elsewhere).toHaveBeenCalledWith("discord", "guild-1");
    expect(mocks.leave).toHaveBeenCalledExactlyOnceWith("guild-1");
    mocks.leave.mockClear();
    mocks.elsewhere.mockResolvedValue(true);
    await callback({ code: "c", state: state() });
    expect(mocks.leave).not.toHaveBeenCalled();
  });

  describe("what it refuses, and the bot it takes back out", () => {
    // Discord adds the bot at consent: a refused callback with a verified
    // state exchanges the code only to leave that server. Forged or garbage
    // state never triggers abandon (a forged code must not drive Discord).
    const refused = async (query: Record<string, string>, expected: object, abandons = false) => {
      mocks.fetch.mockClear();
      mocks.leave.mockClear();
      expect(outcome(await callback(query))).toMatchObject(expected);
      expect(mocks.save).not.toHaveBeenCalled();
      if (abandons) {
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(Object.fromEntries((mocks.fetch.mock.calls[0] as [string, RequestInit])[1].body as URLSearchParams))
          .toMatchObject({ code: query.code, redirect_uri: "https://vault.test/api/discord/guild-callback" });
        expect(mocks.leave).toHaveBeenCalledExactlyOnceWith("guild-1");
      } else {
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.leave).not.toHaveBeenCalled();
      }
    };

    it("keeps the bot in a server another community is connected to, and reports the same refusal when the exchange or the leave fails", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mocks.role.mockResolvedValue("member");
      mocks.elsewhere.mockResolvedValue(true);
      expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ reason: "not_admin" });
      expect(mocks.elsewhere).toHaveBeenCalledWith("discord", "guild-1");
      expect(mocks.leave).not.toHaveBeenCalled();

      mocks.elsewhere.mockResolvedValue(false);
      discordAnswers({ error: "invalid_grant" }, 400);
      expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ reason: "not_admin" });
      expect(mocks.leave).not.toHaveBeenCalled();

      discordAnswers({ access_token: "a", guild: { id: "guild-1" } });
      mocks.leave.mockRejectedValue(new Error("Discord 500"));
      expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ reason: "not_admin" });
      mocks.fetch.mockRejectedValue(new Error("socket hang up"));
      expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ reason: "not_admin" });
      expect(logged).toHaveBeenCalledTimes(2);
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("refuses a missing or garbage state, returning to the home page", async () => {
      await refused({ code: "c" }, { path: "/", discord_server: "error", reason: "bad_state" });
      await refused({ code: "c", state: "garbage.mac" }, { path: "/", discord_server: "error", reason: "bad_state" });
      expect(mocks.role).not.toHaveBeenCalled();
    });

    it("refuses a forged state: another community under a real state's signature", async () => {
      const real = state();
      const forged = Buffer.from(JSON.stringify({
        wallet: WALLET, returnTo: RETURN_TO, communityId: "40000000-0000-4000-8000-000000000009",
        purpose: "discord-guild", exp: Date.now() + 600_000,
      })).toString("base64url");
      await refused({ code: "c", state: `${forged}${real.slice(real.lastIndexOf("."))}` }, { path: "/", reason: "bad_state" });
    });

    it("refuses a state signed for another flow, and one that names no community", async () => {
      for (const purpose of ["discord-link", "zoom-host", "google-host", "github-install"] as const) {
        await refused({ code: "c", state: state(purpose) }, { discord_server: "error", reason: "bad_state" });
      }
      // Verified purpose but no communityId: still ours, so abandon runs.
      await refused(
        { code: "c", state: state("discord-guild", {}) },
        { discord_server: "error", reason: "bad_state" },
        true,
      );
      expect(mocks.role).not.toHaveBeenCalled();
    });

    it("refuses a state older than ten minutes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() - 11 * 60_000);
      const stale = state();
      vi.useRealTimers();
      await refused({ code: "c", state: stale }, { path: "/", discord_server: "error", reason: "bad_state" });
    });

    it("reports a declined consent as cancelled and other provider errors as errors", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await refused({ error: "access_denied", state: state() }, { path: RETURN_TO, discord_server: "cancelled", reason: "access_denied" });
      await refused({ error: "invalid_scope", state: state() }, { path: RETURN_TO, discord_server: "error", reason: "invalid_scope" });
    });

    it("refuses a callback without a code", async () => {
      await refused({ state: state() }, { path: RETURN_TO, discord_server: "error", reason: "no_code" });
    });

    it("refuses a callback finished without a session, or by another wallet", async () => {
      mocks.session.mockResolvedValue(null);
      await refused({ code: "c", state: state() }, { discord_server: "error", reason: "no_session" }, true);
      mocks.session.mockResolvedValue({ wallet: OTHER });
      await refused({ code: "c", state: state() }, { discord_server: "error", reason: "wallet_mismatch" }, true);
      expect(mocks.role).not.toHaveBeenCalled();
    });

    it("refuses a wallet that is no longer an admin when the round trip ends", async () => {
      for (const role of ["member", null]) {
        mocks.role.mockResolvedValue(role);
        await refused({ code: "c", state: state() }, { path: RETURN_TO, discord_server: "error", reason: "not_admin" }, true);
      }
    });
  });

  describe("when Discord does not confirm a server", () => {
    it("reports Discord's own error code, saving nothing", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      discordAnswers({ error: "invalid_grant" }, 400);
      expect(outcome(await callback({ code: "c", state: state() })))
        .toMatchObject({ path: RETURN_TO, discord_server: "error", reason: "invalid_grant" });
      mocks.fetch.mockImplementation(async () => new Response("<html>bad gateway</html>", { status: 502 }));
      expect(outcome(await callback({ code: "c", state: state() })))
        .toMatchObject({ discord_server: "error", reason: "token_exchange" });
      expect(logged).toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("reports a network or database failure as an exception", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mocks.fetch.mockRejectedValue(new Error("socket hang up"));
      expect(outcome(await callback({ code: "c", state: state() })))
        .toMatchObject({ path: RETURN_TO, discord_server: "error", reason: "exception" });
      discordAnswers({ access_token: "a", guild: { id: "guild-1" } });
      mocks.save.mockRejectedValue(new Error("save call integration: db down"));
      expect(outcome(await callback({ code: "c", state: state() })))
        .toMatchObject({ discord_server: "error", reason: "exception" });
      expect(logged).toHaveBeenCalledTimes(2);
    });
  });
});
