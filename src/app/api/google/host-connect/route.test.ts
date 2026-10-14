import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MeetApi from "@/lib/calls/meetApi";
import { ForbiddenError } from "@/lib/errors";
import { verifyOAuthState } from "@/lib/oauth/state";

// What the Google host connection does differently; the shared connect /
// disconnect matrix is in src/app/api/discord/guild-connect/route.test.ts.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), admin: vi.fn(), load: vi.fn(), secrets: vi.fn(), remove: vi.fn(), revoke: vi.fn(), elsewhere: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin, memberRole: vi.fn() }));
vi.mock("@/lib/db/callCapture", () => ({
  loadIntegration: mocks.load, loadIntegrationSecrets: mocks.secrets, deleteIntegration: mocks.remove,
  accountConnectedElsewhere: mocks.elsewhere, saveIntegration: vi.fn(), saveIntegrationSecrets: vi.fn(),
}));
vi.mock("@/lib/calls/meetApi", async (importOriginal) => ({
  ...(await importOriginal<typeof MeetApi>()),
  exchangeGoogleHostCode: vi.fn(),
  revokeGoogleToken: mocks.revoke,
}));
vi.mock("@/lib/discord/bot", () => ({ leaveGuild: vi.fn() }));
import { DELETE, GET } from "./route";

const WALLET = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const COMMUNITY_ID = "30000000-0000-4000-8000-000000000001";

const context = { params: Promise.resolve({}) };
const connect = (query: Record<string, string>) =>
  GET(new Request(`https://vault.test/api/google/host-connect?${new URLSearchParams(query)}`), context);
const disconnect = () => DELETE(new Request("https://vault.test/api/google/host-connect", {
  method: "DELETE", body: JSON.stringify({ communityId: COMMUNITY_ID }), headers: { "Content-Type": "application/json" },
}), context);

beforeAll(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "state-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.GOOGLE_CLIENT_ID = "google-client";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue("admin");
  mocks.load.mockResolvedValue({ id: "int-google", community_id: COMMUNITY_ID, provider: "google", external_account_id: "sub-1", label: "Google account" });
  mocks.secrets.mockResolvedValue({ access_token: "a", refresh_token: "google-refresh", expires_at: "2026-10-01T00:00:00Z" });
  mocks.remove.mockResolvedValue(undefined);
  mocks.revoke.mockResolvedValue(undefined);
  mocks.elsewhere.mockResolvedValue(false);
});

describe("google host-connect API", () => {
  it("asks Google for offline Meet read access, with a fresh consent and a google-host state", async () => {
    const response = await connect({ communityId: COMMUNITY_ID, returnTo: "/c/demo/settings/calls" });
    expect(response.status).toBe(307);
    const url = new URL(response.headers.get("location")!);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const { state, ...query } = Object.fromEntries(url.searchParams);
    expect(query).toEqual({
      client_id: "google-client",
      response_type: "code",
      scope: "openid https://www.googleapis.com/auth/meetings.space.readonly",
      access_type: "offline",
      prompt: "consent select_account",
      redirect_uri: "https://vault.test/api/google/host-callback",
    });
    expect(verifyOAuthState("google-host", state!)).toEqual({
      wallet: WALLET, returnTo: "/c/demo/settings/calls", communityId: COMMUNITY_ID,
    });
    expect(verifyOAuthState("google-link", state!)).toBeNull();
  });

  it("tells the page when the Google client id is not configured, rather than answering a JSON error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const saved = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      const response = await connect({ communityId: COMMUNITY_ID, returnTo: "/c/demo/settings/calls" });
      expect(response.status).toBe(307);
      const url = new URL(response.headers.get("location")!);
      expect(url.pathname).toBe("/c/demo/settings/calls");
      expect(Object.fromEntries(url.searchParams)).toEqual({ google_host: "error", reason: "oauth_env_missing" });
      expect(logged).toHaveBeenCalled();
    } finally {
      process.env.GOOGLE_CLIENT_ID = saved;
      logged.mockRestore();
    }
  });

  it("refuses a non-admin before sending anyone to Google", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const response = await connect({ communityId: COMMUNITY_ID });
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });

  it("reads the refresh token before the row (and its tokens) goes, then revokes the grant at Google", async () => {
    const response = await disconnect();
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.secrets).toHaveBeenCalledExactlyOnceWith("int-google");
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("int-google");
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith("google-refresh");
    expect(mocks.secrets.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]!);
    expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(mocks.revoke.mock.invocationCallOrder[0]!);
  });

  it("deletes a connection whose tokens are already gone without revoking anything, and does nothing when none exists", async () => {
    mocks.secrets.mockResolvedValue(null);
    expect((await disconnect()).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith("int-google");
    expect(mocks.revoke).not.toHaveBeenCalled();
    mocks.remove.mockClear();
    mocks.load.mockResolvedValue(null);
    expect(await (await disconnect()).json()).toEqual({ ok: true });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("keeps the grant when another community is still connected to the same Google account", async () => {
    mocks.elsewhere.mockResolvedValue(true);
    expect((await disconnect()).status).toBe(200);
    expect(mocks.elsewhere).toHaveBeenCalledWith("google", "sub-1");
    expect(mocks.remove).toHaveBeenCalledWith("int-google");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("refuses a non-admin's disconnect", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await disconnect()).status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});
