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

describe("GET /.well-known/oauth-protected-resource (root form)", () => {
  it("publishes RFC 9728 metadata for /api/mcp with APP_URL as the authorization server, not the Host", async () => {
    const res = await GET(new Request("http://attacker.test/.well-known/oauth-protected-resource", { headers: { host: "attacker.test" } }), context);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("attacker.test");
    expect(JSON.parse(text)).toEqual({
      resource: `${APP}/api/mcp`,
      authorization_servers: [APP],
      scopes_supported: ["communities:read", "proposals:write", "tasks:write", "payouts:write", "governance:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Treasury Guild",
      resource_documentation: `${APP}/docs/ai-assistants`,
    });
  });

  it("is readable from any origin without a session", async () => {
    const res = await GET(new Request(`${APP}/.well-known/oauth-protected-resource`, { headers: { origin: "https://client.example" } }), context);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("answers the CORS preflight", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
