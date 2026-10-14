import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { verifyOAuthState } from "@/lib/oauth/state";

// A community host connection's connect / disconnect matrix (hostLink.ts),
// run through the Discord server's route; /api/zoom/connect and
// /api/google/host-connect cover what differs.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), admin: vi.fn(), role: vi.fn(), load: vi.fn(), secrets: vi.fn(), remove: vi.fn(),
  elsewhere: vi.fn(), leave: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin, memberRole: mocks.role }));
vi.mock("@/lib/db/callCapture", () => ({
  loadIntegration: mocks.load, loadIntegrationSecrets: mocks.secrets, deleteIntegration: mocks.remove,
  accountConnectedElsewhere: mocks.elsewhere, saveIntegration: vi.fn(), saveIntegrationSecrets: vi.fn(),
}));
vi.mock("@/lib/discord/bot", () => ({ leaveGuild: mocks.leave }));
import { DELETE, GET } from "./route";

const WALLET = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const COMMUNITY_ID = "30000000-0000-4000-8000-000000000001";
const INTEGRATION = { id: "int-1", community_id: COMMUNITY_ID, provider: "discord", external_account_id: "guild-1", label: "Guild" };

const context = { params: Promise.resolve({}) };
const connect = (query: Record<string, string> = { communityId: COMMUNITY_ID }) =>
  GET(new Request(`https://vault.test/api/discord/guild-connect?${new URLSearchParams(query)}`), context);
const disconnect = (body: object = { communityId: COMMUNITY_ID }, headers: Record<string, string> = {}) =>
  DELETE(new Request("https://vault.test/api/discord/guild-connect", {
    method: "DELETE", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  }), context);
const location = (response: Response) => new URL(response.headers.get("location")!);

beforeAll(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "state-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.DISCORD_CLIENT_ID = "discord-client";
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.admin.mockResolvedValue("admin");
  mocks.load.mockResolvedValue(INTEGRATION);
  mocks.secrets.mockResolvedValue(null);
  mocks.remove.mockResolvedValue(undefined);
  mocks.elsewhere.mockResolvedValue(false);
  mocks.leave.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discord guild-connect API", () => {
  describe("GET: start the connection", () => {
    it("sends an admin to Discord to add the bot, with View Channels only", async () => {
      const response = await connect({ communityId: COMMUNITY_ID, returnTo: "/c/demo/settings/calls" });
      expect(response.status).toBe(307);
      const url = location(response);
      expect(`${url.origin}${url.pathname}`).toBe("https://discord.com/oauth2/authorize");
      const { state, ...query } = Object.fromEntries(url.searchParams);
      expect(query).toEqual({
        client_id: "discord-client",
        scope: "bot identify",
        permissions: "1024",
        response_type: "code",
        redirect_uri: "https://vault.test/api/discord/guild-callback",
      });
      expect(verifyOAuthState("discord-guild", state!)).toEqual({
        wallet: WALLET, returnTo: "/c/demo/settings/calls", communityId: COMMUNITY_ID,
      });
      expect(mocks.admin).toHaveBeenCalledExactlyOnceWith(COMMUNITY_ID, WALLET);
    });

    it("signs the state for this flow only", async () => {
      const state = location(await connect()).searchParams.get("state")!;
      for (const purpose of ["discord-link", "zoom-host", "google-host", "github-install"] as const) {
        expect(verifyOAuthState(purpose, state), purpose).toBeNull();
      }
    });

    it("falls back to the home page for a return path that is not the app's", async () => {
      const returnTo = async (requested?: string) => verifyOAuthState(
        "discord-guild",
        location(await connect({ communityId: COMMUNITY_ID, ...(requested && { returnTo: requested }) })).searchParams.get("state")!,
      )?.returnTo;
      expect(await returnTo()).toBe("/");
      expect(await returnTo("https://evil.test/c/demo")).toBe("/");
      expect(await returnTo("//evil.test")).toBe("/");
    });

    it("refuses a member who is not an admin, with no redirect", async () => {
      mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
      const response = await connect();
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
    });

    it("answers 401 without a session and 400 without a community, before any role lookup", async () => {
      expect((await connect({})).status).toBe(400);
      expect((await connect({ communityId: "not-a-uuid" })).status).toBe(400);
      mocks.session.mockRejectedValue(new UnauthorizedError());
      expect((await connect()).status).toBe(401);
      expect(mocks.admin).not.toHaveBeenCalled();
    });
  });

  describe("DELETE: forget the connection", () => {
    it("deletes the community's connection, then takes the bot out of the server", async () => {
      const response = await disconnect();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.admin).toHaveBeenCalledExactlyOnceWith(COMMUNITY_ID, WALLET);
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(COMMUNITY_ID, "discord");
      expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("int-1");
      expect(mocks.elsewhere).toHaveBeenCalledExactlyOnceWith("discord", "guild-1");
      expect(mocks.leave).toHaveBeenCalledExactlyOnceWith("guild-1");
      // "Elsewhere" is asked once this community's own row is gone.
      expect(mocks.remove.mock.invocationCallOrder[0]).toBeLessThan(mocks.elsewhere.mock.invocationCallOrder[0]!);
    });

    it("leaves the bot in a server another community still uses", async () => {
      mocks.elsewhere.mockResolvedValue(true);
      expect((await disconnect()).status).toBe(200);
      expect(mocks.remove).toHaveBeenCalledWith("int-1");
      expect(mocks.leave).not.toHaveBeenCalled();
    });

    it("is a no-op when nothing is connected", async () => {
      mocks.load.mockResolvedValue(null);
      expect(await (await disconnect()).json()).toEqual({ ok: true });
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.leave).not.toHaveBeenCalled();
    });

    it("refuses a non-admin, no session, another origin and a body without a community, deleting nothing", async () => {
      expect((await disconnect({})).status).toBe(400);
      expect((await disconnect({ communityId: COMMUNITY_ID }, { Origin: "https://evil.test" })).status).toBe(403);
      mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
      expect((await disconnect()).status).toBe(403);
      mocks.session.mockRejectedValue(new UnauthorizedError());
      expect((await disconnect()).status).toBe(401);
      expect(mocks.load).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.leave).not.toHaveBeenCalled();
    });
  });
});
