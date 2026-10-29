import { beforeEach, describe, expect, it, vi } from "vitest";
import { signOAuthState } from "@/lib/oauth/state";
import { TooManyRequestsError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), role: vi.fn(), owner: vi.fn(), save: vi.fn(), getInstallation: vi.fn(),
  exchange: vi.fn(), sees: vi.fn(), rateLimit: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/db/github", () => ({ installationOwner: mocks.owner, saveInstallation: mocks.save }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/github/installAuth", () => ({
  exchangeInstallCode: mocks.exchange, userSeesInstallation: mocks.sees,
}));
vi.mock("@/lib/github/app", () => ({
  githubApp: () => ({ octokit: { rest: { apps: { getInstallation: mocks.getInstallation } } } }),
}));
import { GET } from "./route";

const WALLET = "addr_test1abc";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const OTHER_COMMUNITY = "10000000-0000-4000-8000-000000000002";
const RETURN_TO = "/c/demo/settings/github";
const MINUTE = 60 * 1000;
const CODE = "user-oauth-code";
const context = { params: Promise.resolve({}) };

const state = (overrides: object = {}) =>
  signOAuthState("github-install", {
    wallet: WALLET, returnTo: RETURN_TO, communityId: COMMUNITY, jti: crypto.randomUUID(), ...overrides,
  });
const setup = (query: Record<string, string>) =>
  GET(new Request(`https://vault.test/api/github/setup?${new URLSearchParams(query)}`), context);
const installed = (query: Record<string, string> = {}) =>
  setup({ installation_id: "42", code: CODE, setup_action: "install", state: state(), ...query });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const installation = (overrides: object = {}) => ({
  data: { id: 42, account: { login: "guild-org", type: "Organization" }, created_at: ago(MINUTE), updated_at: ago(MINUTE), ...overrides },
});

function outcome(response: Response): { path: string; query: Record<string, string> } {
  expect(response.status).toBe(307);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin).toBe("https://vault.test");
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.CRON_SECRET = "test-secret";
  process.env.APP_URL = "https://vault.test";
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.role.mockResolvedValue("admin");
  mocks.owner.mockResolvedValue(null);
  mocks.getInstallation.mockResolvedValue(installation());
  mocks.exchange.mockResolvedValue("ghu_token");
  mocks.sees.mockResolvedValue(true);
  mocks.rateLimit.mockResolvedValue(undefined);
});

describe("GET /api/github/setup", () => {
  it("binds a fresh, unclaimed installation the installing user can see", async () => {
    const response = await installed({ communityId: OTHER_COMMUNITY });
    expect(outcome(response)).toEqual({ path: RETURN_TO, query: { install: "connected" } });
    expect(mocks.role).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.exchange).toHaveBeenCalledWith(CODE);
    expect(mocks.sees).toHaveBeenCalledWith("ghu_token", 42);
    expect(mocks.getInstallation).toHaveBeenCalledWith({ installation_id: 42 });
    expect(mocks.owner).toHaveBeenCalledWith(42);
    expect(mocks.save).toHaveBeenCalledWith("insert", {
      installation_id: 42, community_id: COMMUNITY, account_login: "guild-org", account_type: "Organization",
    });
  });

  it("lets the owner role install too", async () => {
    mocks.role.mockResolvedValue("owner");
    expect(outcome(await installed()).query).toEqual({ install: "connected" });
  });

  it("refuses when the user token does not list the installation", async () => {
    mocks.sees.mockResolvedValue(false);
    expect(outcome(await installed())).toEqual({
      path: RETURN_TO, query: { install: "error", reason: "installation_not_yours" },
    });
    expect(mocks.getInstallation).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a replayed install state", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    expect(outcome(await installed())).toEqual({
      path: RETURN_TO, query: { install: "error", reason: "state_replay" },
    });
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("refuses a state without a single-use jti", async () => {
    const bare = signOAuthState("github-install", {
      wallet: WALLET, returnTo: RETURN_TO, communityId: COMMUNITY,
    });
    expect(outcome(await setup({ installation_id: "42", code: CODE, state: bare }))).toEqual({
      path: RETURN_TO, query: { install: "error", reason: "bad_state" },
    });
  });

  describe("the installation id is only a query parameter", () => {
    it("never moves an installation another community holds", async () => {
      mocks.owner.mockResolvedValue({ community_id: OTHER_COMMUNITY });
      expect(outcome(await installed())).toEqual({ path: RETURN_TO, query: { install: "taken" } });
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("refuses an unclaimed installation GitHub did not create in the last 5 minutes", async () => {
      for (const data of [
        { created_at: ago(6 * MINUTE), updated_at: ago(MINUTE) },
        { created_at: null, updated_at: null },
      ]) {
        mocks.getInstallation.mockResolvedValueOnce(installation(data));
        expect(outcome(await installed())).toEqual({
          path: RETURN_TO, query: { install: "error", reason: "installation_not_recent" },
        });
      }
      expect(mocks.save).not.toHaveBeenCalled();
    });

    it("refuses a missing or malformed id without asking GitHub", async () => {
      const queries: Record<string, string>[] = [
        { state: state(), code: CODE },
        { state: state(), code: CODE, installation_id: "abc" },
        { state: state(), code: CODE, installation_id: "-1" },
      ];
      for (const query of queries) {
        expect(outcome(await setup(query))).toEqual({
          path: RETURN_TO, query: { install: "error", reason: "no_installation" },
        });
      }
      expect(mocks.getInstallation).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
    });
  });

  describe("the wallet-bound state", () => {
    const refused = async (query: Record<string, string>) => {
      const result = outcome(await setup({ installation_id: "42", code: CODE, ...query }));
      expect(mocks.role).not.toHaveBeenCalled();
      expect(mocks.getInstallation).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
      return result;
    };

    it("refuses a missing, forged or foreign state and one without a community", async () => {
      const bad = { path: "/", query: { install: "error", reason: "bad_state" } };
      expect(await refused({})).toEqual(bad);
      expect(await refused({ state: "garbage.mac" })).toEqual(bad);
      const link = signOAuthState("github-link", { wallet: WALLET, returnTo: RETURN_TO, communityId: COMMUNITY });
      expect(await refused({ state: link })).toEqual(bad);
      const bare = signOAuthState("github-install", { wallet: WALLET, returnTo: RETURN_TO });
      expect(await refused({ state: bare })).toEqual({ path: RETURN_TO, query: { install: "error", reason: "bad_state" } });
    });

    it("refuses no session and the session of another wallet", async () => {
      mocks.session.mockResolvedValue(null);
      expect((await refused({ state: state() })).query).toEqual({ install: "error", reason: "no_session" });
      mocks.session.mockResolvedValue({ wallet: "addr_test1other" });
      expect((await refused({ state: state() })).query).toEqual({ install: "error", reason: "wallet_mismatch" });
    });

    it("reports a cancelled install", async () => {
      expect(await refused({ state: state(), error: "access_denied" })).toEqual({
        path: RETURN_TO, query: { install: "cancelled", reason: "access_denied" },
      });
    });

    it("refuses a missing user OAuth code", async () => {
      expect(outcome(await setup({ installation_id: "42", state: state() }))).toEqual({
        path: RETURN_TO, query: { install: "error", reason: "no_code" },
      });
    });
  });

  it("refuses a wallet that is no longer an admin of the community", async () => {
    for (const role of ["member", null]) {
      mocks.role.mockResolvedValueOnce(role);
      expect(outcome(await installed())).toEqual({ path: RETURN_TO, query: { install: "error", reason: "not_admin" } });
    }
    expect(mocks.getInstallation).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("reports a GitHub or database failure as an exception", async () => {
    mocks.getInstallation.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    expect(outcome(await installed())).toEqual({ path: RETURN_TO, query: { install: "error", reason: "exception" } });
    expect(mocks.save).not.toHaveBeenCalled();

    mocks.save.mockRejectedValueOnce(new Error("save installation: duplicate key"));
    expect(outcome(await installed())).toEqual({ path: RETURN_TO, query: { install: "error", reason: "exception" } });
  });
});
