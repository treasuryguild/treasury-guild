// One agent API endpoint: its scope, its zod input and the function that
// authorizes, loads and shapes the answer. Two thin adapters serve each one
// (v1Route in src/lib/api/route.ts for REST, src/lib/mcp/tools.ts for MCP),
// so every check is written once, as the multisig repo does by invoking its
// v1 handlers in-process.
import "server-only";

import type { z } from "zod";
import { requireScope, type ApiCaller } from "@/lib/api/caller";
import { parseInput } from "@/lib/api/parse";
import { ForbiddenError } from "@/lib/errors";
import type { ApiScope } from "@/lib/mcp/scopes";

export interface ApiEndpoint<I = unknown, O extends object = object> {
  /** The scope the caller needs; a list means any one of them (the endpoint checks further itself). */
  scope: ApiScope | readonly ApiScope[];
  input: z.ZodType<I>;
  // Method syntax on purpose: a typed endpoint is then assignable to the
  // untyped `ApiEndpoint` the registries hold.
  run(caller: ApiCaller, input: I): Promise<O>;
}

export function defineEndpoint<I, O extends object>(endpoint: ApiEndpoint<I, O>): ApiEndpoint<I, O> {
  return endpoint;
}

/** The scopes an endpoint accepts, any one of which lets a caller use it. */
export function endpointScopes(endpoint: Pick<ApiEndpoint, "scope">): readonly ApiScope[] {
  return typeof endpoint.scope === "string" ? [endpoint.scope] : endpoint.scope;
}

/** Whether a caller holding `scopes` may use the endpoint at all. */
export function endpointAllowed(endpoint: Pick<ApiEndpoint, "scope">, scopes: readonly ApiScope[]): boolean {
  return endpointScopes(endpoint).some((scope) => scopes.includes(scope));
}

/** Check the scope, validate `raw` against the input schema, run. */
export async function callEndpoint<I, O extends object>(
  endpoint: ApiEndpoint<I, O>,
  caller: ApiCaller,
  raw: unknown,
): Promise<O> {
  if (typeof endpoint.scope === "string") {
    requireScope(caller, endpoint.scope);
  } else if (!endpointAllowed(endpoint, caller.scopes)) {
    throw new ForbiddenError(`This connection was not granted any of ${endpoint.scope.join(", ")}`);
  }
  return endpoint.run(caller, parseInput(endpoint.input, raw ?? {}));
}
