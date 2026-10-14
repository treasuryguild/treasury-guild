import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/errors";
import { verifyOAuthState } from "@/lib/oauth/state";

// The personal account link's connect / disconnect matrix (identityLink.ts),
// run through Discord's route; /api/google/connect covers what differs.
const mocks = vi.hoisted(() => ({ session: vi.fn(), unlink: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/identities", () => ({
  unlinkIdentity: mocks.unlink, linkIdentity: vi.fn(), fillAttendeeWalletsByIdentity: vi.fn(),
}));
vi.mock("@/lib/db/membership", () => ({ ensureContributor: vi.fn() }));
import { DELETE, GET } from "./route";

const WALLET = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";

const context = { params: Promise.resolve({}) };
const connect = (query = "") => GET(new Request(`https://vault.test/api/discord/connect${query}`), context);
const disconnect = (headers: Record<string, string> = {}) =>
  DELETE(new Request("https://vault.test/api/discord/connect", { method: "DELETE", headers }), context);
const location = (response: Response) => new URL(response.headers.get("location")!);

beforeAll(() => {
  process.env.CRON_SECRET = "cron-secret";
  process.env.OAUTH_STATE_SECRET = "state-secret";
  process.env.APP_URL = "https://vault.test";
  process.env.DISCORD_CLIENT_ID = "discord-client";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.unlink.mockResolvedValue(undefined);
});

describe("discord connect API", () => {
  describe("GET: start the link", () => {
    it("sends the wallet to Discord's consent screen, asking for identify only", async () => {
      const response = await connect();
      expect(response.status).toBe(307);
      const url = location(response);
      expect(`${url.origin}${url.pathname}`).toBe("https://discord.com/oauth2/authorize");
      const { state, ...query } = Object.fromEntries(url.searchParams);
      expect(query).toEqual({
        client_id: "discord-client",
        response_type: "code",
        scope: "identify",
        redirect_uri: "https://vault.test/api/discord/oauth-callback",
      });
      expect(verifyOAuthState("discord-link", state!)).toEqual({ wallet: WALLET, returnTo: "/settings" });
    });

    it("signs the state for this flow only", async () => {
      const state = location(await connect()).searchParams.get("state")!;
      for (const purpose of ["google-link", "github-link", "discord-guild", "zoom-host", "google-host"] as const) {
        expect(verifyOAuthState(purpose, state), purpose).toBeNull();
      }
    });

    it("carries an app path to return to, and falls back to Settings for anything else", async () => {
      const returnTo = async (requested: string) =>
        verifyOAuthState("discord-link", location(await connect(`?returnTo=${encodeURIComponent(requested)}`)).searchParams.get("state")!)?.returnTo;
      expect(await returnTo("/c/demo/calls")).toBe("/c/demo/calls");
      expect(await returnTo("https://evil.test/c/demo")).toBe("/settings");
      expect(await returnTo("//evil.test")).toBe("/settings");
      expect(await returnTo("/\\evil.test")).toBe("/settings");
      expect(await returnTo("/c/demo?next=//evil.test")).toBe("/settings");
    });

    it("answers 401 without a session, with no redirect", async () => {
      mocks.session.mockRejectedValue(new UnauthorizedError());
      const response = await connect();
      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
    });

    it("tells the page when the Discord client id is not configured, rather than answering a JSON error", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const saved = process.env.DISCORD_CLIENT_ID;
      delete process.env.DISCORD_CLIENT_ID;
      try {
        const url = location(await connect(`?returnTo=${encodeURIComponent("/c/demo/calls")}`));
        expect(url.pathname).toBe("/c/demo/calls");
        expect(Object.fromEntries(url.searchParams)).toEqual({ discord: "error", reason: "oauth_env_missing" });
      } finally {
        process.env.DISCORD_CLIENT_ID = saved;
        logged.mockRestore();
      }
    });
  });

  describe("DELETE: forget the link", () => {
    it("removes the session wallet's own Discord account", async () => {
      const response = await disconnect();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.unlink).toHaveBeenCalledExactlyOnceWith(WALLET, "discord");
    });

    it("answers 401 without a session and 403 to another origin, removing nothing", async () => {
      expect((await disconnect({ Origin: "https://evil.test" })).status).toBe(403);
      mocks.session.mockRejectedValue(new UnauthorizedError());
      expect((await disconnect()).status).toBe(401);
      expect(mocks.unlink).not.toHaveBeenCalled();
    });
  });
});
