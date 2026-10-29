import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), client: vi.fn(), grant: vi.fn(), code: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/oauth", () => ({ findOAuthClient: mocks.client, saveOAuthGrant: mocks.grant, insertAuthorizationCode: mocks.code }));

import { signPayload } from "@/lib/oauth/state";
import { hashToken } from "@/lib/oauthServer/accessToken";
import { encodeAuthorizationRequest, type AuthorizationRequest } from "@/lib/oauthServer/request";
import { POST } from "./route";

const APP = "https://vault.example";
const WALLET = "addr_test1approver";
const REDIRECT = "http://127.0.0.1:51763/callback";
const REQUEST: AuthorizationRequest = {
  clientId: "gv-client-1", clientName: "Test assistant", verifiedDomain: null, redirectUri: REDIRECT,
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", scopes: ["communities:read"],
  resource: `${APP}/api/mcp`, state: "xyz",
};
const context = { params: Promise.resolve({}) };
const post = (body: object, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/oauth/decision", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
  }), context);

const saved = { APP_URL: process.env.APP_URL, OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET };
beforeAll(() => {
  process.env.APP_URL = APP;
  process.env.OAUTH_STATE_SECRET = "state-test-secret";
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.client.mockResolvedValue({
    client_id: REQUEST.clientId,
    // Loopback port is ignored when matching (RFC 8252).
    redirect_uris: ["http://127.0.0.1/callback"],
  });
  mocks.grant.mockResolvedValue(undefined);
  mocks.code.mockResolvedValue(undefined);
});

function nothingGranted() {
  expect(mocks.grant).not.toHaveBeenCalled();
  expect(mocks.code).not.toHaveBeenCalled();
}

describe("POST /api/oauth/decision", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post({ request: encodeAuthorizationRequest(REQUEST), approved: true })).status).toBe(401);
    nothingGranted();
  });

  it("refuses a cross-site request", async () => {
    const res = await post({ request: encodeAuthorizationRequest(REQUEST), approved: true }, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    nothingGranted();
  });

  it("refuses an invalid body and a handle it did not sign", async () => {
    expect((await post({ approved: true })).status).toBe(400);
    expect((await post({ request: encodeAuthorizationRequest(REQUEST) })).status).toBe(400);
    expect((await post({ request: "forged.handle", approved: true })).status).toBe(400);
    // Signed by this server, but for another flow.
    const other = signPayload("github-link", REQUEST, 60_000);
    expect((await post({ request: other, approved: true })).status).toBe(400);
    // Expired.
    const expired = signPayload("mcp-authorize", REQUEST, -1000);
    expect((await post({ request: expired, approved: true })).status).toBe(400);
    nothingGranted();
  });

  it("saves the grant and a hashed one-minute code for the session wallet, then returns the client redirect", async () => {
    const before = Date.now();
    // A body-supplied wallet must never be the one that grants.
    const res = await post({ request: encodeAuthorizationRequest(REQUEST), approved: true, wallet: "addr_test1victim" });
    expect(res.status).toBe(200);
    const to = new URL((await res.json()).redirectTo);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("state")).toBe("xyz");
    expect(to.searchParams.get("iss")).toBe(APP);
    const code = to.searchParams.get("code")!;
    expect(code.length).toBeGreaterThan(20);

    expect(mocks.client).toHaveBeenCalledWith(REQUEST.clientId);
    expect(mocks.grant).toHaveBeenCalledWith(WALLET, REQUEST.clientId, ["communities:read"]);
    expect(mocks.code).toHaveBeenCalledWith({
      code_hash: hashToken(code),
      client_id: REQUEST.clientId,
      wallet_address: WALLET,
      scopes: ["communities:read"],
      resource: REQUEST.resource,
      redirect_uri: REDIRECT,
      code_challenge: REQUEST.codeChallenge,
      expires_at: expect.any(String),
    });
    const row = mocks.code.mock.calls[0]![0] as { code_hash: string; expires_at: string };
    expect(row.code_hash).not.toBe(code);
    const ttl = Date.parse(row.expires_at) - before;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("sends a denial back as access_denied and grants nothing", async () => {
    const res = await post({ request: encodeAuthorizationRequest(REQUEST), approved: false });
    expect(res.status).toBe(200);
    const to = new URL((await res.json()).redirectTo);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("xyz");
    expect(to.searchParams.get("iss")).toBe(APP);
    expect(to.searchParams.has("code")).toBe(false);
    nothingGranted();
  });

  it("lets ticked scopes only narrow the handle: nothing left is refused, extras are dropped", async () => {
    const handle = encodeAuthorizationRequest(REQUEST);
    expect((await post({ request: handle, approved: true, scopes: [] })).status).toBe(400);
    expect((await post({ request: handle, approved: true, scopes: ["treasury:write"] })).status).toBe(400);
    nothingGranted();
    expect((await post({ request: handle, approved: true, scopes: ["communities:read", "treasury:write"] })).status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledWith(WALLET, REQUEST.clientId, ["communities:read"]);
  });

  it("refuses a client that is no longer registered", async () => {
    mocks.client.mockResolvedValue(null);
    expect((await post({ request: encodeAuthorizationRequest(REQUEST), approved: true })).status).toBe(400);
    nothingGranted();
  });

  it("refuses a redirect URI the client did not register", async () => {
    mocks.client.mockResolvedValue({
      client_id: REQUEST.clientId,
      redirect_uris: ["https://assistant.example/cb"],
    });
    expect((await post({ request: encodeAuthorizationRequest(REQUEST), approved: true })).status).toBe(400);
    expect((await post({ request: encodeAuthorizationRequest(REQUEST), approved: false })).status).toBe(400);
    nothingGranted();
  });

  it("re-checks the redirect target before it can reach window.location", async () => {
    const handle = encodeAuthorizationRequest({ ...REQUEST, redirectUri: "javascript:alert(1)" });
    for (const approved of [true, false]) {
      const res = await post({ request: handle, approved });
      expect(res.status).toBe(400);
      expect(await res.json()).not.toHaveProperty("redirectTo");
    }
    nothingGranted();
  });
});
