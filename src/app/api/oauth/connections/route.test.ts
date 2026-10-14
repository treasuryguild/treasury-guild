import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), list: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/oauth", () => ({ listOAuthGrants: mocks.list, deleteOAuthGrant: mocks.remove }));

import { DELETE, GET } from "./route";

const WALLET = "addr_test1member";
const URL_CONNECTIONS = "http://localhost/api/oauth/connections";
const context = { params: Promise.resolve({}) };
const del = (query: string, headers: Record<string, string> = {}) =>
  DELETE(new Request(`${URL_CONNECTIONS}${query}`, { method: "DELETE", headers }), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.list.mockResolvedValue([]);
  mocks.remove.mockResolvedValue(true);
});

describe("GET /api/oauth/connections", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await GET(new Request(URL_CONNECTIONS), context)).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("lists the session wallet's connections, dropping scopes this server no longer knows", async () => {
    mocks.list.mockResolvedValue([
      {
        client_id: "gv-1", wallet_address: WALLET, scopes: ["communities:read", "retired:scope"],
        updated_at: "2026-09-28T10:00:00Z", last_used_at: "2026-09-29T08:00:00Z", oauth_clients: { client_name: "Claude" },
      },
      {
        client_id: "https://assistant.example/client.json", wallet_address: WALLET, scopes: ["communities:read"],
        updated_at: "2026-09-27T10:00:00Z", last_used_at: null, oauth_clients: null,
      },
    ]);
    const res = await GET(new Request(URL_CONNECTIONS), context);
    expect(res.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(WALLET);
    expect(await res.json()).toEqual({
      connections: [
        { clientId: "gv-1", clientName: "Claude", scopes: ["communities:read"], connectedAt: "2026-09-28T10:00:00Z", lastUsedAt: "2026-09-29T08:00:00Z" },
        {
          clientId: "https://assistant.example/client.json", clientName: "https://assistant.example/client.json",
          scopes: ["communities:read"], connectedAt: "2026-09-27T10:00:00Z", lastUsedAt: null,
        },
      ],
    });
  });
});

describe("DELETE /api/oauth/connections", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await del("?clientId=gv-1")).status).toBe(401);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await del("?clientId=gv-1", { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses a request that names no client", async () => {
    expect((await del("")).status).toBe(400);
    expect((await del("?clientId=")).status).toBe(400);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("deletes the session wallet's grant for that client", async () => {
    const res = await del(`?clientId=${encodeURIComponent("https://assistant.example/client.json")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.remove).toHaveBeenCalledWith(WALLET, "https://assistant.example/client.json");
  });

  it("answers 404 when the wallet holds no such connection", async () => {
    mocks.remove.mockResolvedValue(false);
    expect((await del("?clientId=gv-unknown")).status).toBe(404);
  });
});
