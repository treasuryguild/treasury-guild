import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signOAuthState, type OAuthPurpose } from "@/lib/oauth/state";

// What the Zoom host connection does differently: Basic-auth token request,
// an account lookup, and the token pair saved for later reports. The shared
// callback matrix is in src/app/api/discord/guild-callback/route.test.ts.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), role: vi.fn(), save: vi.fn(), saveSecrets: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role, requireAdmin: vi.fn() }));
vi.mock("@/lib/db/callCapture", () => ({
  saveIntegration: mocks.save, saveIntegrationSecrets: mocks.saveSecrets,
  loadIntegration: vi.fn(), loadIntegrationSecrets: vi.fn(), deleteIntegration: vi.fn(), accountConnectedElsewhere: vi.fn(),
}));
vi.mock("@/lib/discord/bot", () => ({ leaveGuild: vi.fn() }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: vi.fn() }));
import { GET } from "./route";

const WALLET = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const COMMUNITY_ID = "30000000-0000-4000-8000-000000000001";
const RETURN_TO = "/c/demo/settings/integrations";
const TOKEN_URL = "https://zoom.us/oauth/token";
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

const context = { params: Promise.resolve({}) };
const state = (purpose: OAuthPurpose = "zoom-host") =>
  signOAuthState(purpose, { wallet: WALLET, returnTo: RETURN_TO, communityId: COMMUNITY_ID });
const callback = (query: Record<string, string>) =>
  GET(new Request(`https://vault.test/api/zoom/oauth-callback?${new URLSearchParams(query)}`), context);
const outcome = (response: Response) => {
  expect(response.status).toBe(307);
  const url = new URL(response.headers.get("location")!);
  return { path: url.pathname, ...Object.fromEntries(url.searchParams) };
};
const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
/** Zoom's two answers: the token endpoint's, then the user lookup's. */
function zoomAnswers(token: Response, user: Response = json({
  account_id: "zoom-acc", display_name: "Signius Host", email: "host@signius.test",
})) {
  mocks.fetch.mockImplementation(async (url: string | URL) => (String(url) === TOKEN_URL ? token : user));
}

beforeAll(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "state-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.ZOOM_CLIENT_ID = "zoom-client";
  process.env.ZOOM_CLIENT_SECRET = "zoom-secret";
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.role.mockResolvedValue("admin");
  mocks.save.mockResolvedValue({ id: "int-zoom" });
  mocks.saveSecrets.mockResolvedValue(undefined);
  zoomAnswers(json({ access_token: "zoom-access", refresh_token: "zoom-refresh", expires_in: 3600 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("zoom oauth-callback API", () => {
  it("saves the host account and its token pair", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const response = await callback({ code: "the-code", state: state() });
    expect(response.status).toBe(307);
    expect(outcome(response)).toEqual({ path: RETURN_TO, zoom: "connected" });

    const [tokenUrl, tokenInit] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(TOKEN_URL);
    // The client credentials travel as HTTP Basic, not in the form.
    expect((tokenInit.headers as Record<string, string>).Authorization)
      .toBe(`Basic ${Buffer.from("zoom-client:zoom-secret").toString("base64")}`);
    expect(Object.fromEntries(tokenInit.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://vault.test/api/zoom/oauth-callback",
    });
    expect(mocks.fetch.mock.calls[1]).toEqual(["https://api.zoom.us/v2/users/me", { headers: { Authorization: "Bearer zoom-access" } }]);

    // The account id events are matched by and a label: no email is kept.
    // The row and its token pair go in one database step.
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      community_id: COMMUNITY_ID, provider: "zoom", external_account_id: "zoom-acc", label: "Signius Host", created_by: WALLET,
    }, { access_token: "zoom-access", refresh_token: "zoom-refresh", expires_at: "2026-09-30T13:00:00.000Z" });
    expect(mocks.saveSecrets).not.toHaveBeenCalled();
  });

  it("labels the account by first and last name when it has no display name", async () => {
    zoomAnswers(json({ access_token: "a", refresh_token: "r" }), json({ account_id: "zoom-acc", first_name: "Ann", last_name: "Lee" }));
    await callback({ code: "c", state: state() });
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ label: "Ann Lee" }), expect.objectContaining({ access_token: "a" }));
  });

  it("saves nothing when Zoom refuses the code, sends half a token pair or names no account", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [token, user] of [
      [json({ reason: "Invalid authorization code", error: "invalid_grant" }, 400), undefined],
      [json({ access_token: "a" }), undefined],
      [json({ access_token: "a", refresh_token: "r" }), json({ code: 124 }, 401)],
      [json({ access_token: "a", refresh_token: "r" }), json({ display_name: "Host" })],
    ] as const) {
      zoomAnswers(token, user);
      expect(outcome(await callback({ code: "c", state: state() }))).toEqual({ path: RETURN_TO, zoom: "error", reason: "exception" });
    }
    expect(logged).toHaveBeenCalledTimes(4);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.saveSecrets).not.toHaveBeenCalled();
  });

  it("reports a failed save as an exception: the row and its tokens are one step, so neither is kept", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.save.mockRejectedValue(new Error("save call integration: db down"));
    expect(outcome(await callback({ code: "c", state: state() }))).toEqual({ path: RETURN_TO, zoom: "error", reason: "exception" });
    expect(logged).toHaveBeenCalledOnce();
    expect(mocks.saveSecrets).not.toHaveBeenCalled();
  });

  it("accepts only its own state and still needs an admin", async () => {
    for (const purpose of ["google-host", "discord-guild", "google-link"] as const) {
      expect(outcome(await callback({ code: "c", state: state(purpose) }))).toEqual({ path: "/", zoom: "error", reason: "bad_state" });
    }
    mocks.role.mockResolvedValue("member");
    expect(outcome(await callback({ code: "c", state: state() }))).toEqual({ path: RETURN_TO, zoom: "error", reason: "not_admin" });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
