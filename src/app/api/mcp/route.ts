// POST /api/mcp: the Model Context Protocol endpoint (stateless). One HTTP POST
// is one complete MCP exchange: no session store, no SSE stream, no
// resumability, so GET and DELETE (the 2025-era session verbs) answer 405.
// The SDK serves the 2026-07-28 envelope protocol and the 2025 `initialize`
// handshake from the same tool registry (src/lib/mcp/tools.ts).
//
// Only an OAuth access token authenticates here, never the session cookie:
// this endpoint is not the app's, and a cookie would let any page the user
// visits drive it. See src/app/api/mcp/README.md.
import { createMcpHandler } from "@modelcontextprotocol/server";
import { resolveApiCaller, type ApiCaller } from "@/lib/api/caller";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { HttpError, UnauthorizedError } from "@/lib/errors";
import { API_SCOPES, formatApiScopes } from "@/lib/mcp/scopes";
import { createMcpServer } from "@/lib/mcp/server";
import { protectedResourceMetadataUrl } from "@/lib/oauthServer/config";

const MAX_BODY_BYTES = 256 * 1024;

function jsonRpcError(status: number, code: number, message: string, headers?: HeadersInit): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers });
}

/**
 * RFC 9728 challenge: `resource_metadata` lets a client discover the
 * authorization server and start OAuth unprompted. Every scope is named:
 * clients (Claude Code among them) request exactly the challenge's `scope`,
 * so one left out here could never be granted. The user narrows it on the
 * consent screen.
 */
function unauthorized(message: string): Response {
  return jsonRpcError(401, -32001, message, {
    "WWW-Authenticate": `Bearer resource_metadata="${protectedResourceMetadataUrl()}", scope="${formatApiScopes(API_SCOPES)}"`,
  });
}

export async function POST(req: Request): Promise<Response> {
  // MCP clients are servers and send no Origin. One present means a browser is
  // driving this: a DNS-rebinding / cross-site vector, refused outright.
  if (req.headers.get("origin")) return jsonRpcError(403, -32000, "Forbidden origin");

  let caller: ApiCaller;
  try {
    caller = await resolveApiCaller(req, { allowSession: false });
  } catch (err) {
    if (err instanceof UnauthorizedError) return unauthorized(err.message);
    console.error("MCP caller resolution failed", err);
    return jsonRpcError(500, -32603, "Internal error");
  }

  try {
    // Per wallet, once per exchange (one POST is at most one tool call), in
    // the same budget as /api/v1.
    await enforceRateLimit("agentApi", caller.wallet);
  } catch (err) {
    if (err instanceof HttpError) return jsonRpcError(err.status, -32000, err.message);
    console.error("MCP rate limit failed", err);
    return jsonRpcError(500, -32603, "Internal error");
  }

  // Refuse a declared oversize body before reading it; a chunked one is
  // measured after.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return jsonRpcError(413, -32600, "Request too large");
  }
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return jsonRpcError(413, -32600, "Request too large");
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    return jsonRpcError(400, -32700, "Parse error");
  }

  try {
    // A fresh handler, server and transport per request: a transport is single
    // use, and one hoisted to module scope fails on the second request.
    const mcp = createMcpHandler(() => createMcpServer(caller), {
      onerror: (error) => console.error("MCP protocol error", error),
    });
    const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: text });
    return await mcp.fetch(forwarded, { parsedBody });
  } catch (err) {
    console.error("MCP request failed", err);
    return jsonRpcError(500, -32603, "Internal error");
  }
}

function methodNotAllowed(): Response {
  return jsonRpcError(405, -32000, "Method not allowed", { Allow: "POST" });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
