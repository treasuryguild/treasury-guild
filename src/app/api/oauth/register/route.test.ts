import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooManyRequestsError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), rateLimit: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/db/oauth", () => ({ saveOAuthClient: mocks.save, findOAuthClient: vi.fn() }));

import { hashToken } from "@/lib/oauthServer/accessToken";
import { OPTIONS, POST } from "./route";

const context = { params: Promise.resolve({}) };
const CREATED = "2026-09-28T10:00:00.000Z";
function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.save.mockImplementation(async (row: object) => ({ ...row, created_at: CREATED }));
});

describe("POST /api/oauth/register", () => {
  it("registers a public client and answers 201 with its metadata", async () => {
    const res = await POST(request({
      client_name: "  Claude Code  ", client_uri: "https://claude.example", redirect_uris: ["http://127.0.0.1/callback", "https://app.example/cb"],
    }), context);
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rateLimit).toHaveBeenCalledWith("oauthRegister", "203.0.113.7");
    expect(mocks.save).toHaveBeenCalledWith({
      client_id: expect.stringMatching(/^gv-[0-9a-f-]{36}$/),
      is_metadata_url: false,
      client_name: "Claude Code",
      client_uri: "https://claude.example",
      redirect_uris: ["http://127.0.0.1/callback", "https://app.example/cb"],
      token_endpoint_auth_method: "none",
      secret_hash: null,
    });
    const saved = mocks.save.mock.calls[0]![0] as { client_id: string };
    const body = await res.json();
    expect(body).toEqual({
      client_id: saved.client_id,
      client_id_issued_at: Date.parse(CREATED) / 1000,
      client_name: "Claude Code",
      redirect_uris: ["http://127.0.0.1/callback", "https://app.example/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(body).not.toHaveProperty("client_secret");
  });

  it("gives a confidential client a secret once and stores only its hash", async () => {
    const res = await POST(request({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "client_secret_post" }), context);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_secret).toEqual(expect.any(String));
    expect(body.client_secret_expires_at).toBe(0);
    expect(body.token_endpoint_auth_method).toBe("client_secret_post");
    const saved = mocks.save.mock.calls[0]![0] as { secret_hash: string; token_endpoint_auth_method: string };
    expect(saved.token_endpoint_auth_method).toBe("client_secret_post");
    expect(saved.secret_hash).toBe(hashToken(body.client_secret));
    expect(saved.secret_hash).not.toBe(body.client_secret);
  });

  it("names a client that declared no name, and bounds a long one", async () => {
    await POST(request({ redirect_uris: ["https://app.example/cb"] }), context);
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ client_name: "Unnamed AI assistant", client_uri: null }));
    await POST(request({ redirect_uris: ["https://app.example/cb"], client_name: "n".repeat(500) }), context);
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ client_name: "n".repeat(200) }));
  });

  it("refuses redirect URIs a browser must not be sent to", async () => {
    const refused = [
      ["http://app.example/cb"],
      ["javascript:alert(1)"],
      ["https://app.example/cb#fragment"],
      ["https://app.example/cb", "not a url"],
    ];
    for (const redirect_uris of refused) {
      const res = await POST(request({ redirect_uris }), context);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_redirect_uri", error_description: expect.any(String) });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a missing, empty, non-string or oversize redirect_uris list", async () => {
    const refused = [
      {},
      { redirect_uris: [] },
      { redirect_uris: "https://app.example/cb" },
      { redirect_uris: [42, null] },
      { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://app.example/cb${i}`) },
    ];
    for (const body of refused) {
      const res = await POST(request(body), context);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_redirect_uri");
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, an unknown auth method and an oversize body", async () => {
    const notJson = await POST(request("redirect_uris=https://app.example/cb"), context);
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "invalid_client_metadata", error_description: "Body must be JSON" });

    const method = await POST(request({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "client_secret_basic" }), context);
    expect(method.status).toBe(400);
    expect((await method.json()).error).toBe("invalid_client_metadata");

    const big = await POST(request({ redirect_uris: ["https://app.example/cb"], client_name: "x".repeat(8 * 1024) }), context);
    expect(big.status).toBe(413);
    expect((await big.json()).error).toBe("invalid_client_metadata");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("is open: no session, and another origin is not refused", async () => {
    const res = await POST(request({ redirect_uris: ["https://app.example/cb"] }, { origin: "https://client.example", "sec-fetch-site": "cross-site" }), context);
    expect(res.status).toBe(201);
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("is rate limited per IP before anything is stored", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    const res = await POST(request({ redirect_uris: ["https://app.example/cb"] }), context);
    expect(res.status).toBe(429);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("answers the CORS preflight", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
