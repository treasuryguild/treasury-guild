// Service-role query plumbing: unwrap PostgREST results so transport/RLS
// failures surface as errors instead of being mistaken for "no rows".
//
// The client is untyped (no generated DB types), so callers name the row
// shape via the generic; embedded relations in particular are inferred as
// arrays by supabase-js even when `!inner` yields one row.
import "server-only";

import type { PostgrestError } from "@supabase/supabase-js";
import { PgCode } from "@/lib/constants";
import { ConflictError, ForbiddenError, InvariantError, NotFoundError } from "@/lib/errors";

export { serviceClient } from "@/lib/supabase/service";

interface Result {
  data: unknown;
  error: PostgrestError | null;
}

function fail(what: string, error: PostgrestError): never {
  throw new InvariantError(`${what}: ${error.message}`);
}

/** Exactly one row expected (`.single()`); throws when missing or on error. */
export function must<T>(res: Result, what: string): T {
  if (res.error) fail(what, res.error);
  if (res.data === null || res.data === undefined) {
    throw new InvariantError(`${what}: no row`);
  }
  return res.data as T;
}

/** Zero or one row (`.maybeSingle()`); throws only on error. */
export function maybe<T>(res: Result, what: string): T | null {
  if (res.error) fail(what, res.error);
  return (res.data as T | null | undefined) ?? null;
}

/** A row list; throws on error, `[]` when null. */
export function rows<T>(res: Result, what: string): T[] {
  if (res.error) fail(what, res.error);
  return (res.data as T[] | null | undefined) ?? [];
}

/** Fetch complete lists for totals, which must not silently stop at a row cap. */
export async function allRows<T>(
  loadPage: (from: number, to: number) => PromiseLike<Result>,
  what: string,
): Promise<T[]> {
  const result: T[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const page = rows<T>(await loadPage(from, from + pageSize - 1), what);
    result.push(...page);
    if (page.length < pageSize) return result;
  }
}

/** Write with no data of interest; throws on error. */
export function check(res: { error: PostgrestError | null }, what: string): void {
  if (res.error) fail(what, res.error);
}

export type ErrorClass = new (message: string) => Error;
export type RpcErrorOverrides = Partial<Record<string, ErrorClass>>;

/**
 * How RPCs report rule failures: `no_data_found` for a missing row,
 * `insufficient_privilege` for a refused actor, and a check / FK violation or
 * a lost race for a state that no longer allows the change.
 */
const RPC_ERRORS: Record<string, ErrorClass> = {
  [PgCode.NoDataFound]: NotFoundError,
  [PgCode.InsufficientPrivilege]: ForbiddenError,
  [PgCode.CheckViolation]: ConflictError,
  [PgCode.ForeignKeyViolation]: ConflictError,
  [PgCode.SerializationFailure]: ConflictError,
  [PgCode.DeadlockDetected]: ConflictError,
};

/** Throw an RPC error as the HttpError its code stands for (`overrides` wins). */
export function throwRpcError(error: PostgrestError, overrides: RpcErrorOverrides = {}): never {
  const Mapped = overrides[error.code] ?? RPC_ERRORS[error.code];
  throw Mapped ? new Mapped(error.message) : new Error(error.message);
}

/** An RPC's data, or its error mapped by `throwRpcError`. */
export function rpc<T>(res: Result, overrides?: RpcErrorOverrides): T {
  if (res.error) throwRpcError(res.error, overrides);
  return res.data as T;
}

/** A to-one embed, which supabase-js types as an array. */
export function relation<T>(value: T | T[]): T {
  return Array.isArray(value) ? value[0]! : value;
}

/** A to-one embed that may be missing. */
export function optionalRelation<T>(value: T | T[] | null | undefined): T | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}
