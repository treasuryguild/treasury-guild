import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooManyRequestsError } from "@/lib/errors";

// Drives the real MCP SDK through the real route: the transport wiring is the
// part most likely to break, and a mocked SDK would prove nothing about it.
// Only storage is mocked.

const mocks = vi.hoisted(() => ({
  grant: vi.fn(),
  touch: vi.fn(),
  rateLimit: vi.fn(),
  communities: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@/lib/db/oauth", () => ({ findOAuthGrant: mocks.grant, touchOAuthGrant: mocks.touch }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/db/membership", () => ({ communitiesForWallet: mocks.communities }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session }));

import { mintAccessToken } from "@/lib/oauthServer/accessToken";
import { DELETE, GET, POST } from "./route";

const WALLET = "addr_test1qzwallet";
const URL_MCP = "http://localhost:3000/api/mcp";
const GRANT_CREATED = "2026-09-28T10:00:00.123456+00:00";
let token: string;

beforeAll(async () => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.MCP_TOKEN_SECRET = "mcp-test-secret";
  token = (await mintAccessToken({ wallet: WALLET, clientId: "client-1", scopes: ["communities:read"], grantCreatedAt: Date.parse(GRANT_CREATED) })).token;
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.grant.mockResolvedValue({ wallet_address: WALLET, client_id: "client-1", scopes: ["communities:read"], last_used_at: null, created_at: GRANT_CREATED });
  mocks.touch.mockResolvedValue(undefined);
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.communities.mockResolvedValue([
    { role: "admin", community: { id: "c1", slug: "signius", name: "Signius", description: null, network: 0, visibility: "private" } },
  ]);
});

function rpc(method: string, params: object, headers: Record<string, string> = {}, id = 1): Request {
  return new Request(URL_MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "vitest", version: "1.0.0" },
};

type RpcBody = { result?: Record<string, unknown>; error?: { message: string } };

/** A JSON-RPC answer, sent as JSON or as one SSE `message` event (the 2025 streamable-HTTP path). */
async function body(res: Response): Promise<RpcBody> {
  const text = await res.text();
  const data = text.startsWith("event:") || text.startsWith("data:")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("")
    : text;
  return JSON.parse(data) as RpcBody;
}

describe("/api/mcp", () => {
  it("answers 401 with the RFC 9728 challenge naming every scope when no token is sent", async () => {
    const res = await POST(rpc("initialize", INITIALIZE, { authorization: "" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/api/mcp", scope="communities:read proposals:write tasks:write payouts:write"',
    );
  });

  it("never accepts the session cookie in place of a token", async () => {
    const res = await POST(rpc("initialize", INITIALIZE, { authorization: "" }));
    expect(res.status).toBe(401);
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("refuses a request a browser declares an origin for", async () => {
    const res = await POST(rpc("initialize", INITIALIZE, { origin: "https://evil.test" }));
    expect(res.status).toBe(403);
  });

  it("stops working as soon as the grant is revoked", async () => {
    mocks.grant.mockResolvedValue(null);
    expect((await POST(rpc("initialize", INITIALIZE))).status).toBe(401);
  });

  it("rejects a token whose scopes the grant no longer covers", async () => {
    mocks.grant.mockResolvedValue({ wallet_address: WALLET, client_id: "client-1", scopes: [], last_used_at: null, created_at: GRANT_CREATED });
    expect((await POST(rpc("initialize", INITIALIZE))).status).toBe(401);
  });

  it("refuses a token issued under an earlier grant (Disconnect, then approved again)", async () => {
    mocks.grant.mockResolvedValue({
      wallet_address: WALLET, client_id: "client-1", scopes: ["communities:read"], last_used_at: null,
      created_at: "2026-09-28T11:00:00+00:00",
    });
    expect((await POST(rpc("initialize", INITIALIZE))).status).toBe(401);
  });

  it("refuses a declared oversize body before reading it", async () => {
    const res = await POST(rpc("initialize", INITIALIZE, { "content-length": String(1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("passes the rate limit's 429 through", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    expect((await POST(rpc("initialize", INITIALIZE))).status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", WALLET);
  });

  it("initializes with the server instructions, and serves a second request (no shared transport)", async () => {
    const first = await body(await POST(rpc("initialize", INITIALIZE)));
    expect(first.result?.serverInfo).toMatchObject({ name: "treasury-guild" });
    expect(String(first.result?.instructions)).toContain("Nothing on this server can vote, sign or pay");

    const second = await POST(rpc("tools/list", {}, {}, 2));
    expect(second.status).toBe(200);
    const tools = (await body(second)).result?.tools as { name: string; inputSchema: { required?: string[] }; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual([
      "guild_whoami", "community_list", "treasury_overview", "task_list", "budget_summary", "proposal_list",
      "signing_queue", "transaction_list", "workgroup_list", "incoming_list", "member_list",
      "transaction_detail", "funding_summary", "call_list", "proposal_detail",
    ]);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    // Defaulted inputs stay optional for the model.
    expect(tools.find((t) => t.name === "task_list")?.inputSchema.required).toEqual(["community"]);
  });

  it("offers the proposal tools only to a connection granted proposals:write", async () => {
    const scopes = ["communities:read", "proposals:write"] as const;
    const writer = (await mintAccessToken({ wallet: WALLET, clientId: "client-1", scopes, grantCreatedAt: Date.parse(GRANT_CREATED) })).token;
    mocks.grant.mockResolvedValue({ wallet_address: WALLET, client_id: "client-1", scopes: [...scopes], last_used_at: null, created_at: GRANT_CREATED });
    const res = await POST(rpc("tools/list", {}, { authorization: `Bearer ${writer}` }));
    const tools = (await body(res)).result?.tools as { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[];
    expect(tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(["proposal_create", "draft_confirm"]);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["proposal_preview", "proposal_withdraw_preview"]));
    // The previews of the other write scopes stay hidden.
    expect(tools.map((t) => t.name)).not.toContain("payout_preview");
    expect(tools.map((t) => t.name)).not.toContain("task_preview");
    // Clients need an object at the top of every input schema.
    for (const tool of tools) expect(tool.inputSchema.type, tool.name).toBe("object");

    // The grant no longer covers the write scope: the tools are gone on the next request.
    mocks.grant.mockResolvedValue({ wallet_address: WALLET, client_id: "client-1", scopes: ["communities:read"], last_used_at: null, created_at: GRANT_CREATED });
    const narrowed = await POST(rpc("tools/list", {}, { authorization: `Bearer ${writer}` }, 2));
    const names = ((await body(narrowed)).result?.tools as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain("proposal_preview");
    expect(names).not.toContain("proposal_create");
  });

  it("calls a tool: JSON text plus structuredContent, no annotations", async () => {
    const res = await POST(rpc("tools/call", { name: "community_list", arguments: {} }));
    const result = (await body(res)).result as {
      content: { type: string; text: string; annotations?: unknown }[];
      structuredContent: { communities: { slug: string; role: string; network: string }[] };
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.communities).toEqual([
      expect.objectContaining({ slug: "signius", role: "admin", network: "preprod", url: "http://localhost:3000/c/signius" }),
    ]);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).not.toHaveProperty("annotations");
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(mocks.communities).toHaveBeenCalledWith(WALLET);
  });

  it("reports an endpoint's error as an isError result the model can read", async () => {
    const res = await POST(rpc("tools/call", { name: "task_list", arguments: { community: "" } }));
    const result = (await body(res)).result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("answers 405 to the 2025 session verbs", async () => {
    expect(GET().status).toBe(405);
    expect(DELETE().status).toBe(405);
  });
});
