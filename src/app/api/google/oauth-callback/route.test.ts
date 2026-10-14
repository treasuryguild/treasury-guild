import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signOAuthState, type OAuthPurpose } from "@/lib/oauth/state";

// What Google's personal link does differently: the account is the `sub` of
// the ID token, with no profile lookup and no name. The shared callback
// matrix is in src/app/api/discord/oauth-callback/route.test.ts.
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
const CLIENT_ID = "google-client.apps.googleusercontent.com";
const SUB = "108234567890123456789";

const context = { params: Promise.resolve({}) };
const state = (purpose: OAuthPurpose = "google-link") => signOAuthState(purpose, { wallet: WALLET, returnTo: "/settings" });
const callback = (query: Record<string, string>) =>
  GET(new Request(`https://vault.test/api/google/oauth-callback?${new URLSearchParams(query)}`), context);
const outcome = (response: Response) => {
  expect(response.status).toBe(307);
  const url = new URL(response.headers.get("location")!);
  return { path: url.pathname, ...Object.fromEntries(url.searchParams) };
};
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An ID token as Google's token endpoint returns it (the signature is not re-checked: it came over TLS). */
const idToken = (claims: object = {}) =>
  `${b64({ alg: "RS256" })}.${b64({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: SUB, ...claims })}.sig`;
const googleAnswers = (body: object, status = 200) =>
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify(body), { status }));

beforeAll(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "state-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.contributor.mockResolvedValue({ created: false });
  mocks.link.mockResolvedValue("linked");
  mocks.fill.mockResolvedValue(0);
  googleAnswers({ access_token: "google-access", id_token: idToken() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("google oauth-callback API", () => {
  it("links the ID token's subject, with one token request and nothing else stored", async () => {
    expect(outcome(await callback({ code: "the-code", state: state() }))).toEqual({ path: "/settings", google: "connected" });

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: "google-secret",
      code: "the-code",
      redirect_uri: "https://vault.test/api/google/oauth-callback",
    });
    expect(mocks.link).toHaveBeenCalledExactlyOnceWith({ wallet: WALLET, provider: "google", externalId: SUB, displayName: null });
    // Meet reports carry this id: attendee rows captured before the link get the wallet.
    expect(mocks.fill).toHaveBeenCalledExactlyOnceWith("google", SUB, WALLET);
  });

  it("links nothing for an ID token of another app or issuer, or an answer without one", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const body of [
      { access_token: "a", id_token: idToken({ aud: "another-app.apps.googleusercontent.com" }) },
      { access_token: "a", id_token: idToken({ iss: "https://accounts.evil.test" }) },
      { access_token: "a", id_token: idToken({ sub: "" }) },
      { access_token: "a", id_token: "not-a-jwt" },
      { access_token: "a" },
    ]) {
      googleAnswers(body);
      expect(outcome(await callback({ code: "c", state: state() }))).toEqual({ path: "/settings", google: "error", reason: "exception" });
    }
    googleAnswers({ error: "invalid_grant" }, 400);
    expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ google: "error", reason: "exception" });
    expect(logged).toHaveBeenCalledTimes(6);
    expect(mocks.contributor).not.toHaveBeenCalled();
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.fill).not.toHaveBeenCalled();
  });

  it("accepts only its own state: not Discord's link, not the meeting host's", async () => {
    for (const purpose of ["discord-link", "google-host"] as const) {
      expect(outcome(await callback({ code: "c", state: state(purpose) }))).toEqual({ path: "/settings", google: "error", reason: "bad_state" });
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it("refuses a callback finished without a session", async () => {
    mocks.session.mockResolvedValue(null);
    expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ google: "error", reason: "no_session" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
