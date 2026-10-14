import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MeetApi from "@/lib/calls/meetApi";
import { UpstreamError } from "@/lib/errors";
import { signOAuthState, type OAuthPurpose } from "@/lib/oauth/state";

// What the Google host callback does differently; the shared callback matrix
// is in src/app/api/discord/guild-callback/route.test.ts. Google's token
// exchange (meetApi.exchangeGoogleHostCode) is mocked: nothing leaves the process.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), role: vi.fn(), save: vi.fn(), saveSecrets: vi.fn(), exchange: vi.fn(),
  load: vi.fn(), loadSecrets: vi.fn(), elsewhere: vi.fn(), revoke: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role, requireAdmin: vi.fn() }));
vi.mock("@/lib/db/callCapture", () => ({
  saveIntegration: mocks.save, saveIntegrationSecrets: mocks.saveSecrets,
  loadIntegration: mocks.load, loadIntegrationSecrets: mocks.loadSecrets, deleteIntegration: vi.fn(), accountConnectedElsewhere: mocks.elsewhere,
}));
vi.mock("@/lib/calls/meetApi", async (importOriginal) => ({
  ...(await importOriginal<typeof MeetApi>()),
  exchangeGoogleHostCode: mocks.exchange,
  revokeGoogleToken: mocks.revoke,
}));
vi.mock("@/lib/discord/bot", () => ({ leaveGuild: vi.fn() }));
import { GET } from "./route";

const WALLET = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const COMMUNITY_ID = "30000000-0000-4000-8000-000000000001";
const RETURN_TO = "/c/demo/settings/calls";
const TOKENS = { access_token: "google-access", refresh_token: "google-refresh", expires_at: "2026-10-01T01:00:00.000Z" };

const context = { params: Promise.resolve({}) };
const state = (purpose: OAuthPurpose = "google-host") =>
  signOAuthState(purpose, { wallet: WALLET, returnTo: RETURN_TO, communityId: COMMUNITY_ID });
const callback = (query: Record<string, string>) =>
  GET(new Request(`https://vault.test/api/google/host-callback?${new URLSearchParams(query)}`), context);
function outcome(response: Response) {
  expect(response.status).toBe(307);
  const url = new URL(response.headers.get("location")!);
  return { path: url.pathname, ...Object.fromEntries(url.searchParams) };
}

beforeAll(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "state-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.GOOGLE_CLIENT_ID = "google-client";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.role.mockResolvedValue("admin");
  mocks.save.mockResolvedValue({ id: "int-google" });
  mocks.saveSecrets.mockResolvedValue(undefined);
  mocks.exchange.mockResolvedValue({ accountId: "google-sub-1", tokens: TOKENS });
  mocks.load.mockResolvedValue(null);
  mocks.loadSecrets.mockResolvedValue({ access_token: "old-a", refresh_token: "old-refresh", expires_at: "2026-09-30T00:00:00.000Z" });
  mocks.elsewhere.mockResolvedValue(false);
  mocks.revoke.mockResolvedValue(undefined);
});

describe("google host-callback API", () => {
  it("saves the account by its OpenID subject with a fixed label, and keeps its tokens", async () => {
    expect(outcome(await callback({ code: "the-code", state: state() }))).toEqual({ path: RETURN_TO, google_host: "connected" });
    expect(mocks.exchange).toHaveBeenCalledExactlyOnceWith("the-code", "https://vault.test/api/google/host-callback");
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      community_id: COMMUNITY_ID, provider: "google", external_account_id: "google-sub-1", label: "Google account", created_by: WALLET,
    }, TOKENS);
    expect(mocks.saveSecrets).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  describe("re-pointing to another Google account", () => {
    const previous = { id: "int-old", community_id: COMMUNITY_ID, provider: "google", external_account_id: "google-sub-0", label: "Google account" };

    it("revokes the replaced account's grant once the new one is saved", async () => {
      mocks.load.mockResolvedValue(previous);
      expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ google_host: "connected" });
      expect(mocks.loadSecrets).toHaveBeenCalledWith("int-old");
      expect(mocks.elsewhere).toHaveBeenCalledWith("google", "google-sub-0");
      expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith("old-refresh");
      expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.revoke.mock.invocationCallOrder[0]!);
    });

    it("never revokes the same account's grant, which is the new one, nor one another community uses", async () => {
      mocks.load.mockResolvedValue({ ...previous, external_account_id: "google-sub-1" });
      await callback({ code: "c", state: state() });
      expect(mocks.loadSecrets).not.toHaveBeenCalled();
      mocks.load.mockResolvedValue(previous);
      mocks.elsewhere.mockResolvedValue(true);
      await callback({ code: "c", state: state() });
      expect(mocks.revoke).not.toHaveBeenCalled();
    });

    it("still reports connected when the revoke fails", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mocks.load.mockResolvedValue(previous);
      mocks.revoke.mockRejectedValue(new Error("network"));
      expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ google_host: "connected" });
      expect(logged).toHaveBeenCalled();
    });
  });

  it("accepts only a google-host state, and only from a wallet still an admin", async () => {
    expect(outcome(await callback({ code: "c", state: state("google-link") }))).toMatchObject({ google_host: "error", reason: "bad_state" });
    expect(outcome(await callback({ code: "c", state: state("zoom-host") }))).toMatchObject({ google_host: "error", reason: "bad_state" });
    mocks.role.mockResolvedValue("member");
    expect(outcome(await callback({ code: "c", state: state() }))).toMatchObject({ path: RETURN_TO, google_host: "error", reason: "not_admin" });
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("names the two failures an admin can fix, and reports the rest as an exception", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fails = async (err: Error, reason: string) => {
      mocks.exchange.mockRejectedValueOnce(err);
      expect(outcome(await callback({ code: "c", state: state() }))).toEqual({ path: RETURN_TO, google_host: "error", reason });
    };
    await fails(new UpstreamError("The Meet permission was not granted: tick it on Google's consent screen"), "meet_permission_not_granted");
    await fails(new UpstreamError("Google returned no refresh token: remove the app's access in the Google account and connect again"), "no_refresh_token");
    await fails(new UpstreamError("Google returned no ID token"), "exception");
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
