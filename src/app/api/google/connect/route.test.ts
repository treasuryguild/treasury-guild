import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/errors";
import { verifyOAuthState } from "@/lib/oauth/state";

// What Google's personal link does differently; the shared connect /
// disconnect matrix is in src/app/api/discord/connect/route.test.ts.
const mocks = vi.hoisted(() => ({ session: vi.fn(), unlink: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/identities", () => ({
  unlinkIdentity: mocks.unlink, linkIdentity: vi.fn(), fillAttendeeWalletsByIdentity: vi.fn(),
}));
vi.mock("@/lib/db/membership", () => ({ ensureContributor: vi.fn() }));
import { DELETE, GET } from "./route";

const WALLET = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const context = { params: Promise.resolve({}) };

beforeAll(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "state-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.GOOGLE_CLIENT_ID = "google-client.apps.googleusercontent.com";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.unlink.mockResolvedValue(undefined);
});

describe("google connect API", () => {
  it("sends the wallet to Google's account chooser, asking for openid only", async () => {
    const response = await GET(new Request("https://vault.test/api/google/connect?returnTo=/c/demo/calls"), context);
    expect(response.status).toBe(307);
    const url = new URL(response.headers.get("location")!);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const { state, ...query } = Object.fromEntries(url.searchParams);
    expect(query).toEqual({
      client_id: "google-client.apps.googleusercontent.com",
      response_type: "code",
      scope: "openid",
      prompt: "select_account",
      redirect_uri: "https://vault.test/api/google/oauth-callback",
    });
    expect(verifyOAuthState("google-link", state!)).toEqual({ wallet: WALLET, returnTo: "/c/demo/calls" });
    // Neither Discord's link nor the meeting host connection accepts it.
    expect(verifyOAuthState("discord-link", state!)).toBeNull();
    expect(verifyOAuthState("google-host", state!)).toBeNull();
  });

  it("removes the session wallet's own Google account", async () => {
    const response = await DELETE(new Request("https://vault.test/api/google/connect", { method: "DELETE" }), context);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.unlink).toHaveBeenCalledExactlyOnceWith(WALLET, "google");
  });

  it("answers 401 without a session on both methods", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await GET(new Request("https://vault.test/api/google/connect"), context)).status).toBe(401);
    expect((await DELETE(new Request("https://vault.test/api/google/connect", { method: "DELETE" }), context)).status).toBe(401);
    expect(mocks.unlink).not.toHaveBeenCalled();
  });
});
