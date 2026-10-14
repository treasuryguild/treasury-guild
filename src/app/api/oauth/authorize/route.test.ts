import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooManyRequestsError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ rateLimit: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/oauthServer/clients", () => ({ resolveClient: mocks.client }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => null, requireSession: async () => null }));

import { decodeAuthorizationRequest } from "@/lib/oauthServer/request";
import { GET } from "./route";

const APP = "https://vault.example";
const REDIRECT = "https://client.example/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CLIENT = { client_id: "gv-client-1", client_name: "Test assistant", redirect_uris: [REDIRECT], is_metadata_url: false };
const VALID = {
  client_id: CLIENT.client_id, redirect_uri: REDIRECT, response_type: "code",
  code_challenge: CHALLENGE, code_challenge_method: "S256", state: "xyz",
};

const saved = { APP_URL: process.env.APP_URL, OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET };
beforeAll(() => {
  process.env.APP_URL = `${APP}/`;
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
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.client.mockResolvedValue(CLIENT);
});

// The request arrives on another Host: the issuer and the consent page must
// still come from APP_URL.
const authorize = (params: Record<string, string>) =>
  GET(new Request(`http://attacker.test/api/oauth/authorize?${new URLSearchParams(params)}`, { headers: { "x-forwarded-for": "203.0.113.7" } }));

async function location(res: Response): Promise<URL> {
  expect(res.status).toBe(302);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return new URL(res.headers.get("location")!);
}

describe("GET /api/oauth/authorize", () => {
  it("sends a valid request to the consent page with a signed handle, and issues no code", async () => {
    const to = await location(await authorize(VALID));
    expect(to.origin).toBe(APP);
    expect(to.pathname).toBe("/oauth/consent");
    expect(to.searchParams.has("code")).toBe(false);
    expect(decodeAuthorizationRequest(to.searchParams.get("request")!)).toEqual({
      clientId: CLIENT.client_id,
      clientName: "Test assistant",
      verifiedDomain: null,
      redirectUri: REDIRECT,
      codeChallenge: CHALLENGE,
      scopes: ["communities:read"],
      resource: `${APP}/api/mcp`,
      state: "xyz",
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith("oauthAuthorize", "203.0.113.7");
    expect(mocks.client).toHaveBeenCalledWith(CLIENT.client_id);
  });

  it("shows a request without client_id or redirect_uri on our own page, as a code", async () => {
    const to = await location(await authorize({ response_type: "code", redirect_uri: REDIRECT }));
    expect(`${to.origin}${to.pathname}`).toBe(`${APP}/oauth/consent`);
    expect([...to.searchParams]).toEqual([["error", "invalid_request"]]);
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("never redirects to the redirect_uri of an unknown client", async () => {
    mocks.client.mockResolvedValue(null);
    const to = await location(await authorize(VALID));
    expect(to.origin).toBe(APP);
    expect([...to.searchParams]).toEqual([["error", "invalid_client"]]);
  });

  it("never redirects to a redirect_uri the client did not register", async () => {
    const to = await location(await authorize({ ...VALID, redirect_uri: "https://evil.example/steal" }));
    expect(to.origin).toBe(APP);
    expect([...to.searchParams]).toEqual([["error", "unregistered_redirect"]]);
  });

  it("bounces a protocol error to the registered redirect with state and iss", async () => {
    const to = await location(await authorize({ ...VALID, response_type: "token" }));
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("error")).toBe("unsupported_response_type");
    expect(to.searchParams.get("error_description")).toEqual(expect.any(String));
    expect(to.searchParams.get("state")).toBe("xyz");
    expect(to.searchParams.get("iss")).toBe(APP);
    expect(to.searchParams.has("code")).toBe(false);
  });

  it("bounces a request without S256 PKCE, and one for another resource", async () => {
    const plain = await location(await authorize({ ...VALID, code_challenge_method: "plain" }));
    expect(plain.searchParams.get("error")).toBe("invalid_request");
    const resource = await location(await authorize({ ...VALID, resource: "https://other.example/api/mcp" }));
    expect(resource.origin).toBe("https://client.example");
    expect(resource.searchParams.get("error")).toBe("invalid_target");
  });

  it("answers 429 as JSON when the IP is over budget", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    const res = await authorize(VALID);
    expect(res.status).toBe(429);
    expect(res.headers.get("location")).toBeNull();
    expect(mocks.client).not.toHaveBeenCalled();
  });
});
