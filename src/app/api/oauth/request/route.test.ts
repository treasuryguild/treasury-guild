import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));

import { signPayload } from "@/lib/oauth/state";
import { API_SCOPE_DESCRIPTIONS } from "@/lib/mcp/scopes";
import { encodeAuthorizationRequest, type AuthorizationRequest } from "@/lib/oauthServer/request";
import { GET } from "./route";

const REQUEST: AuthorizationRequest = {
  clientId: "https://assistant.example/client.json", clientName: "Test assistant", verifiedDomain: "assistant.example",
  redirectUri: "https://assistant.example/callback?x=1", codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  scopes: ["communities:read"], resource: "https://vault.example/api/mcp", state: "secret-state",
};
const context = { params: Promise.resolve({}) };
const get = (query: Record<string, string>) =>
  GET(new Request(`http://localhost/api/oauth/request?${new URLSearchParams(query)}`), context);

const saved = process.env.OAUTH_STATE_SECRET;
beforeAll(() => {
  process.env.OAUTH_STATE_SECRET = "state-test-secret";
});
afterAll(() => {
  if (saved === undefined) delete process.env.OAUTH_STATE_SECRET;
  else process.env.OAUTH_STATE_SECRET = saved;
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(null);
});

describe("GET /api/oauth/request", () => {
  it("describes a signed request to a visitor who is not signed in yet", async () => {
    const res = await get({ request: encodeAuthorizationRequest(REQUEST) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clientId: REQUEST.clientId,
      clientName: "Test assistant",
      verifiedDomain: "assistant.example",
      redirectHost: "assistant.example",
      redirectIsLocal: false,
      scopes: [{ scope: "communities:read", description: API_SCOPE_DESCRIPTIONS["communities:read"] }],
    });
  });

  it("flags a loopback redirect and a self-declared (DCR) client", async () => {
    const res = await get({
      request: encodeAuthorizationRequest({ ...REQUEST, clientId: "gv-1", verifiedDomain: null, redirectUri: "http://127.0.0.1:51763/callback" }),
    });
    expect(await res.json()).toMatchObject({ verifiedDomain: null, redirectHost: "127.0.0.1:51763", redirectIsLocal: true });
  });

  it("keeps the PKCE challenge, the state and the full redirect out of the answer", async () => {
    const text = await (await get({ request: encodeAuthorizationRequest(REQUEST) })).text();
    expect(text).not.toContain(REQUEST.codeChallenge);
    expect(text).not.toContain("secret-state");
    expect(text).not.toContain("callback");
  });

  it("refuses a missing, forged, foreign-purpose or expired handle", async () => {
    expect((await get({})).status).toBe(400);
    expect((await get({ request: "forged.handle" })).status).toBe(400);
    expect((await get({ request: signPayload("github-link", REQUEST, 60_000) })).status).toBe(400);
    expect((await get({ request: signPayload("mcp-authorize", REQUEST, -1000) })).status).toBe(400);
  });
});
