import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));

import { GET, OPTIONS } from "./route";

const APP = "https://vault.example";
const context = { params: Promise.resolve({}) };
const saved = process.env.APP_URL;
beforeAll(() => {
  process.env.APP_URL = `${APP}/`;
});
afterAll(() => {
  if (saved === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = saved;
});

describe("GET /.well-known/oauth-authorization-server", () => {
  it("publishes RFC 8414 metadata whose issuer and endpoints come from APP_URL, not the Host", async () => {
    const res = await GET(new Request("http://attacker.test/.well-known/oauth-authorization-server", { headers: { host: "attacker.test" } }), context);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("attacker.test");
    expect(JSON.parse(text)).toEqual({
      issuer: APP,
      authorization_endpoint: `${APP}/api/oauth/authorize`,
      token_endpoint: `${APP}/api/oauth/token`,
      registration_endpoint: `${APP}/api/oauth/register`,
      scopes_supported: ["communities:read", "proposals:write", "tasks:write", "payouts:write", "governance:write"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${APP}/docs/ai-assistants`,
    });
  });

  it("is readable from any origin without a session", async () => {
    const res = await GET(new Request(`${APP}/.well-known/oauth-authorization-server`, { headers: { origin: "https://client.example" } }), context);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("answers the CORS preflight", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
