// Scope vocabulary of the agent API (/api/mcp and /api/v1). The MCP spec
// defines no scope names, only the machinery; these are ours. Client-safe:
// the consent page shows the descriptions.

export const API_SCOPES = [
  "communities:read",
  "proposals:write",
  "tasks:write",
  "payouts:write",
  "governance:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** What the consent screen says each scope allows, at the moment of the decision. */
export const API_SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "communities:read":
    "Read your communities, their members, treasuries and balances, transactions and incoming funds, funding, workgroups, tasks, calls and their attendees, budgets and proposals, and what waits for your signature. Cannot change, sign or pay anything.",
  "proposals:write":
    "Make or withdraw your proposals after you confirm each one in the conversation; members still vote on them. Cannot vote, sign or pay anything.",
  "tasks:write":
    "Create and edit tasks on app boards you manage, create calls and pay attendance into tasks, each after you confirm it in the conversation. Cannot make a task payable, sign or pay anything.",
  "payouts:write":
    "Prepare payout transactions for tasks ready to pay, after you confirm each one in the conversation. The treasury's signers still sign in the app; nothing is paid until they do.",
  "governance:write":
    "Prepare stake, DRep and Cardano governance vote transactions for plain SDK treasuries you sign for, after you confirm each one in the conversation. The treasury's signers still sign in the app; cannot cast community proposal ballots or pay anything.",
};

/** A scope that lets the assistant change something. Never granted unless asked for and ticked. */
export function isWriteScope(scope: string): boolean {
  return scope.endsWith(":write");
}

/** Every scope that only reads. */
export const READ_SCOPES: readonly ApiScope[] = API_SCOPES.filter((s) => !isWriteScope(s));

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Parse a space-delimited OAuth `scope` string, dropping anything unknown (catalogue order). */
export function parseApiScopes(scope: string | null | undefined): ApiScope[] {
  if (!scope) return [];
  const seen = new Set(scope.split(/\s+/).filter(isApiScope));
  return API_SCOPES.filter((s) => seen.has(s));
}

/** Known scopes from a stored list, in catalogue order. */
export function knownScopes(values: readonly string[]): ApiScope[] {
  return parseApiScopes(values.join(" "));
}

export function formatApiScopes(scopes: readonly ApiScope[]): string {
  return scopes.join(" ");
}
