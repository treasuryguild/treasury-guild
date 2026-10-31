// Type guards for values of unknown shape: decoded chain metadata, provider
// payloads, stored JSON. Client-safe.

/** A plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX_HASH_RE = /^[0-9a-f]{64}$/i;

/** A row id from a URL: anything else would be a Postgres cast error. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** A Cardano transaction hash from a URL (64 hex chars). */
export function isTxHash(value: string): boolean {
  return TX_HASH_RE.test(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((s) => typeof s === "string");
}
