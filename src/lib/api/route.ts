// Route handler wrappers: session/auth prologue, request parsing and the
// single error -> HTTP mapping every API route shares.
//
//   export const POST = sessionRoute<{ txId: string }>(async (req, { params, session }) => {
//     const body = await parseJson(req, signTxSchema);
//     ...
//     return { signedCount };            // -> 200 JSON
//   });
//
// Handlers return a plain JSON value or a Response (cookies, redirects).
// Throw HttpError subclasses (or let lib errors bubble) for non-2xx.
//
// Cross-site guard: the session cookie is SameSite=Lax, which already keeps
// it off cross-site POSTs. `isCrossSite` is defense in depth behind that —
// it rejects mutating requests whose browser *declares* a foreign origin
// (Sec-Fetch-Site / Origin), which also covers sibling subdomains that
// SameSite would treat as same-site. Requests carrying neither header
// (webhooks, cron, curl) are untouched.
import "server-only";

import { NextResponse } from "next/server";
import type { z } from "zod";
import { resolveApiCaller } from "@/lib/api/caller";
import { parseInput } from "@/lib/api/parse";
import { callEndpoint, type ApiEndpoint } from "@/lib/api/v1/endpoint";
import { safeEqual } from "@/lib/auth/crypto";
import type { SessionClaims } from "@/lib/auth/jwt";
import { getSession, requireSession } from "@/lib/auth/session";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { isDevWallet } from "@/lib/dev/access";
import { cronSecret, devWallets, isProduction } from "@/lib/env.server";
import {
  DomainError,
  errorMessage,
  ForbiddenError,
  HttpError,
  UnauthorizedError,
  UpstreamError,
} from "@/lib/errors";

type RouteParams = Record<string, string>;
type NoParams = Record<string, never>;
type JsonValue = Record<string, unknown> | unknown[];

export interface RouteContext<P, S> {
  params: P;
  session: S;
}

export type RouteHandler<P, S> = (
  req: Request,
  ctx: RouteContext<P, S>,
) => Promise<Response | JsonValue>;

type NextRouteHandler<P> = (
  req: Request,
  ctx: { params: Promise<P> },
) => Promise<Response>;

/** Map any thrown value to a JSON error response. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json(
      { error: err.message, ...(err.extra ?? {}) },
      { status: err.status },
    );
  }
  if (err instanceof DomainError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof UpstreamError) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 502 });
  }
  console.error(err);
  // Unexpected failures carry DB and library text: logged above, kept out of
  // production responses.
  const message = isProduction() ? "Internal error" : errorMessage(err, "Internal error");
  return NextResponse.json({ error: message }, { status: 500 });
}

function toResponse(result: Response | JsonValue): Response {
  return result instanceof Response ? result : NextResponse.json(result);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * True when a state-changing request declares an origin other than the host
 * it was sent to. Only headers the browser sets are consulted; a request with
 * neither `Sec-Fetch-Site` nor `Origin` is never considered cross-site.
 */
export function isCrossSite(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  const fetchSite = req.headers.get("sec-fetch-site");
  // "same-site" is a sibling subdomain: not this app. "none" is the user
  // acting directly (address bar, bookmark).
  if (fetchSite) return fetchSite !== "same-origin" && fetchSite !== "none";
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return !!origin;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const host = req.headers.get("host") ?? new URL(req.url).host;
  return originHost !== host;
}

/**
 * The caller's IP for rate limiting: Netlify's own header first (a client
 * cannot set it), else the first X-Forwarded-For hop (local dev).
 */
export function clientIp(req: Request): string {
  const netlify = req.headers.get("x-nf-client-connection-ip")?.trim();
  if (netlify) return netlify;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

function wrap<P extends RouteParams, S>(
  resolveSession: () => Promise<S>,
  handler: RouteHandler<P, S>,
): NextRouteHandler<P> {
  return async (req, ctx) => {
    try {
      if (isCrossSite(req)) {
        throw new ForbiddenError("Cross-site request rejected");
      }
      const session = await resolveSession();
      const params = ((await ctx?.params) ?? {}) as P;
      return toResponse(await handler(req, { params, session }));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Requires a signed-in wallet; 401 otherwise. */
export function sessionRoute<P extends RouteParams = NoParams>(
  handler: RouteHandler<P, SessionClaims>,
): NextRouteHandler<P> {
  return wrap<P, SessionClaims>(requireSession, handler);
}

async function requireDevSession(): Promise<SessionClaims> {
  const session = await requireSession();
  if (!isDevWallet(session.wallet, devWallets())) {
    throw new ForbiddenError("Developer access required");
  }
  return session;
}

/** Internal tools (/api/dev/*): a signed-in wallet listed in DEV_WALLETS; 403 otherwise. */
export function devRoute<P extends RouteParams = NoParams>(
  handler: RouteHandler<P, SessionClaims>,
): NextRouteHandler<P> {
  return wrap<P, SessionClaims>(requireDevSession, handler);
}

/** No auth requirement; the session (or null) is still provided. */
export function publicRoute<P extends RouteParams = NoParams>(
  handler: RouteHandler<P, SessionClaims | null>,
): NextRouteHandler<P> {
  return wrap<P, SessionClaims | null>(getSession, handler);
}

function bearerMatches(header: string | null, secret: string): boolean {
  return header !== null && safeEqual(header, `Bearer ${secret}`);
}

/** Cron trigger: requires `Authorization: Bearer <CRON_SECRET>`. */
export function cronRoute(
  handler: RouteHandler<NoParams, null>,
): NextRouteHandler<NoParams> {
  return async (req, ctx) => {
    try {
      if (!bearerMatches(req.headers.get("authorization"), cronSecret())) {
        throw new UnauthorizedError("Unauthorized");
      }
      const params = ((await ctx?.params) ?? {}) as NoParams;
      return toResponse(await handler(req, { params, session: null }));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

// --- Agent API (/api/v1) ---------------------------------------------------------

/**
 * A /api/v1 GET route over an agent API endpoint (src/lib/api/v1): the same
 * authorization, validation and body the MCP tool of that endpoint returns.
 * The caller is an OAuth access token (Bearer) or the session cookie; query
 * parameters and path segments are the endpoint's input, with "true" /
 * "false" read as booleans.
 */
export function v1Route<P extends RouteParams = NoParams>(
  endpoint: ApiEndpoint,
): NextRouteHandler<P> {
  return async (req, ctx) => {
    try {
      const caller = await resolveApiCaller(req, { allowSession: true });
      // One budget with /api/mcp, so REST cannot be looped where MCP is capped.
      await enforceRateLimit("agentApi", caller.wallet);
      const params = ((await ctx?.params) ?? {}) as P;
      const input: Record<string, unknown> = {};
      for (const [key, value] of new URL(req.url).searchParams) {
        if (!(key in input)) input[key] = value === "true" ? true : value === "false" ? false : value;
      }
      const body = await callEndpoint(endpoint, caller, { ...input, ...params });
      return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/**
 * An agent API endpoint that changes something, as a POST: the JSON body and
 * path segments are its input. Like sessionRoute it refuses a request another
 * site's page sent, since the session cookie is accepted here too (it can
 * already do the same through the app's own routes).
 */
export function v1PostRoute<P extends RouteParams = NoParams>(
  endpoint: ApiEndpoint,
): NextRouteHandler<P> {
  return async (req, ctx) => {
    try {
      if (isCrossSite(req)) throw new ForbiddenError("Cross-site request rejected");
      const caller = await resolveApiCaller(req, { allowSession: true });
      await enforceRateLimit("agentApi", caller.wallet);
      const params = ((await ctx?.params) ?? {}) as P;
      const body: unknown = await req.json().catch(() => ({}));
      const input = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
      const result = await callEndpoint(endpoint, caller, { ...input, ...params });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

// --- OAuth authorization server ------------------------------------------------------

/**
 * Metadata, registration and token endpoints of the agent API's authorization
 * server. They authenticate no cookie (clients are other servers, or a
 * browser-based client on another origin), so there is no session and no
 * cross-site check, and they allow any origin without credentials. Errors
 * thrown as OAuthProtocolError render as `{ error, error_description }`.
 */
export function oauthRoute(
  handler: (req: Request) => Promise<Response | JsonValue>,
): NextRouteHandler<NoParams> {
  return async (req) => {
    let response: Response;
    try {
      response = toResponse(await handler(req));
    } catch (err) {
      response = errorResponse(err);
    }
    for (const [key, value] of Object.entries(OAUTH_HEADERS)) response.headers.set(key, value);
    return response;
  };
}

const OAUTH_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store",
} as const;

/** CORS preflight of an oauthRoute. */
export function oauthPreflight(): Response {
  return new Response(null, { status: 204, headers: OAUTH_HEADERS });
}

// --- Request parsing ---------------------------------------------------------

/** Parse + validate a JSON body. Malformed JSON is treated as `{}`. */
export async function parseJson<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  const body = (await req.json().catch(() => ({}))) ?? {};
  return parseInput(schema, body);
}

/** Parse + validate query params (each key's first value). */
export function parseQuery<T>(req: Request, schema: z.ZodType<T>): T {
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(req.url).searchParams) {
    if (!(key in query)) query[key] = value;
  }
  return parseInput(schema, query);
}
