import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthProtocolError, TooManyRequestsError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  rateLimit: vi.fn(),
  client: vi.fn(),
  code: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/oauthServer/clients", () => ({ resolveClient: mocks.client }));
vi.mock("@/lib/oauthServer/tokens", () => ({ exchangeAuthorizationCode: mocks.code, exchangeRefreshToken: mocks.refresh }));

import { hashToken } from "@/lib/oauthServer/accessToken";
import { OPTIONS, POST } from "./route";

const URL_TOKEN = "http://localhost:3000/api/oauth/token";
const context = { params: Promise.resolve({}) };
const TOKENS = { access_token: "at", token_type: "Bearer", expires_in: 3600, refresh_token: "rt", scope: "communities:read" };

function form(params: Record<string, string>, headers: Record<string, string> = {}): Request {
  return new Request(URL_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.7", ...headers },
    body: new URLSearchParams(params).toString(),
  });
}
function json(text: string): Request {
  return new Request(URL_TOKEN, { method: "POST", headers: { "content-type": "application/json" }, body: text });
}
const CODE_GRANT = { grant_type: "authorization_code", client_id: "client-1", code: "the-code", code_verifier: "the-verifier" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.client.mockResolvedValue({ client_id: "client-1", token_endpoint_auth_method: "none", secret_hash: null });
  mocks.code.mockResolvedValue(TOKENS);
  mocks.refresh.mockResolvedValue(TOKENS);
});

describe("POST /api/oauth/token", () => {
  it("exchanges an authorization code (form-encoded) and answers with CORS * and no-store", async () => {
    const res = await POST(form({ ...CODE_GRANT, redirect_uri: "http://127.0.0.1:5000/cb" }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TOKENS);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rateLimit).toHaveBeenCalledWith("oauthToken", "203.0.113.7");
    expect(mocks.client).toHaveBeenCalledWith("client-1");
    expect(mocks.code).toHaveBeenCalledWith("client-1", {
      code: "the-code", codeVerifier: "the-verifier", redirectUri: "http://127.0.0.1:5000/cb",
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("passes a null redirect_uri when none is sent, and accepts a JSON body", async () => {
    const res = await POST(json(JSON.stringify({ ...CODE_GRANT, ignored: 5 })), context);
    expect(res.status).toBe(200);
    expect(mocks.code).toHaveBeenCalledWith("client-1", { code: "the-code", codeVerifier: "the-verifier", redirectUri: null });
  });

  it("rotates a refresh token, with the optional narrower scope", async () => {
    await POST(form({ grant_type: "refresh_token", client_id: "client-1", refresh_token: "old" }), context);
    expect(mocks.refresh).toHaveBeenLastCalledWith("client-1", { refreshToken: "old", scope: null });
    await POST(form({ grant_type: "refresh_token", client_id: "client-1", refresh_token: "old", scope: "communities:read" }), context);
    expect(mocks.refresh).toHaveBeenLastCalledWith("client-1", { refreshToken: "old", scope: "communities:read" });
    expect(mocks.code).not.toHaveBeenCalled();
  });

  it("needs no session and does not refuse another origin", async () => {
    const res = await POST(form(CODE_GRANT, { origin: "https://client.example", "sec-fetch-site": "cross-site" }), context);
    expect(res.status).toBe(200);
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("refuses an unsupported or missing grant type as { error, error_description }", async () => {
    const grants: Record<string, string>[] = [{ grant_type: "password" }, {}];
    for (const grant of grants) {
      const res = await POST(form({ client_id: "client-1", ...grant }), context);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "unsupported_grant_type", error_description: expect.any(String) });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    expect(mocks.code).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("refuses a request without client_id before resolving anything", async () => {
    const res = await POST(form({ grant_type: "authorization_code", code: "c", code_verifier: "v" }), context);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_client", error_description: "client_id is required" });
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("answers 401 invalid_client for an unknown client", async () => {
    mocks.client.mockResolvedValue(null);
    const res = await POST(form(CODE_GRANT), context);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
    expect(mocks.code).not.toHaveBeenCalled();
  });

  it("refuses a grant with missing parameters", async () => {
    const missing: Record<string, string>[] = [
      { grant_type: "authorization_code", client_id: "client-1", code: "c" },
      { grant_type: "authorization_code", client_id: "client-1", code_verifier: "v" },
      { grant_type: "refresh_token", client_id: "client-1" },
    ];
    for (const params of missing) {
      const res = await POST(form(params), context);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");
    }
    expect(mocks.code).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("authenticates a confidential client by its secret", async () => {
    mocks.client.mockResolvedValue({ client_id: "client-1", token_endpoint_auth_method: "client_secret_post", secret_hash: hashToken("s3cret") });
    const secrets: Record<string, string>[] = [{}, { client_secret: "wrong" }];
    for (const secret of secrets) {
      const res = await POST(form({ ...CODE_GRANT, ...secret }), context);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_client", error_description: "Client authentication failed" });
    }
    expect(mocks.code).not.toHaveBeenCalled();
    expect((await POST(form({ ...CODE_GRANT, client_secret: "s3cret" }), context)).status).toBe(200);
    expect(mocks.code).toHaveBeenCalledTimes(1);
  });

  it("refuses a confidential client that has no stored secret", async () => {
    mocks.client.mockResolvedValue({ client_id: "client-1", token_endpoint_auth_method: "client_secret_post", secret_hash: null });
    expect((await POST(form({ ...CODE_GRANT, client_secret: "anything" }), context)).status).toBe(401);
  });

  it("renders an exchange's protocol error in the OAuth shape", async () => {
    mocks.code.mockRejectedValue(new OAuthProtocolError(400, "invalid_grant", "Authorization code is invalid or expired"));
    const res = await POST(form(CODE_GRANT), context);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant", error_description: "Authorization code is invalid or expired" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("refuses malformed JSON and an oversize body", async () => {
    const bad = await POST(json("{not json"), context);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_request");
    const big = await POST(form({ ...CODE_GRANT, padding: "x".repeat(8 * 1024) }), context);
    expect(big.status).toBe(413);
    expect((await big.json()).error).toBe("invalid_request");
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("passes the rate limit's 429 through without resolving the client", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    const res = await POST(form(CODE_GRANT), context);
    expect(res.status).toBe(429);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("answers the CORS preflight", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
  });
});
