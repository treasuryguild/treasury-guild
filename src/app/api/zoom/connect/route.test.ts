import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { verifyOAuthState } from "@/lib/oauth/state";

// What the Zoom host connection does differently; the shared connect /
// disconnect matrix is in src/app/api/discord/guild-connect/route.test.ts.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), admin: vi.fn(), load: vi.fn(), secrets: vi.fn(), remove: vi.fn(), leave: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin, memberRole: vi.fn() }));
vi.mock("@/lib/db/callCapture", () => ({
  loadIntegration: mocks.load, loadIntegrationSecrets: mocks.secrets, deleteIntegration: mocks.remove,
  accountConnectedElsewhere: vi.fn(), saveIntegration: vi.fn(), saveIntegrationSecrets: vi.fn(),
}));
vi.mock("@/lib/discord/bot", () => ({ leaveGuild: mocks.leave }));
import { DELETE, GET } from "./route";

const WALLET = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const COMMUNITY_ID = "30000000-0000-4000-8000-000000000001";

const context = { params: Promise.resolve({}) };
const connect = (query: Record<string, string>) =>
  GET(new Request(`https://vault.test/api/zoom/connect?${new URLSearchParams(query)}`), context);
const disconnect = () => DELETE(new Request("https://vault.test/api/zoom/connect", {
  method: "DELETE", body: JSON.stringify({ communityId: COMMUNITY_ID }), headers: { "Content-Type": "application/json" },
}), context);

beforeAll(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "state-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.ZOOM_CLIENT_ID = "zoom-client";
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue("admin");
  mocks.load.mockResolvedValue({ id: "int-zoom", community_id: COMMUNITY_ID, provider: "zoom", external_account_id: "zoom-acc", label: "Host" });
  mocks.remove.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("zoom connect API", () => {
  it("sends an admin to Zoom's consent screen with a zoom-host state", async () => {
    const response = await connect({ communityId: COMMUNITY_ID, returnTo: "/c/demo/settings/calls" });
    expect(response.status).toBe(307);
    const url = new URL(response.headers.get("location")!);
    expect(`${url.origin}${url.pathname}`).toBe("https://zoom.us/oauth/authorize");
    const { state, ...query } = Object.fromEntries(url.searchParams);
    expect(query).toEqual({
      response_type: "code",
      client_id: "zoom-client",
      redirect_uri: "https://vault.test/api/zoom/oauth-callback",
    });
    expect(verifyOAuthState("zoom-host", state!)).toEqual({
      wallet: WALLET, returnTo: "/c/demo/settings/calls", communityId: COMMUNITY_ID,
    });
    expect(verifyOAuthState("google-host", state!)).toBeNull();
    expect(verifyOAuthState("discord-guild", state!)).toBeNull();
  });

  it("is a community connection only: there is no personal Zoom link", async () => {
    // Without a community there is nothing to connect, whoever is signed in.
    expect((await connect({})).status).toBe(400);
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const response = await connect({ communityId: COMMUNITY_ID });
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(mocks.admin).toHaveBeenCalledExactlyOnceWith(COMMUNITY_ID, WALLET);
  });

  it("forgets the connection, whose tokens go with the row: nothing to clean up at Zoom", async () => {
    const response = await disconnect();
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(COMMUNITY_ID, "zoom");
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("int-zoom");
    expect(mocks.secrets).not.toHaveBeenCalled();
    expect(mocks.leave).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("refuses a non-admin's disconnect", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await disconnect()).status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
