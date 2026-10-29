// Browser-side API client: one fetch wrapper with a typed error, so every
// component reports failures the same way. Client-safe.

import { errorMessage } from "@/lib/errors";
import type { ApiErrorBody } from "./types";

export type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.error);
    this.name = "ApiError";
  }

  /** Optimistic-concurrency conflict: the caller should refetch state. */
  get conflict(): boolean {
    return !!this.body.conflict;
  }
}

type QueryValue = string | number | boolean | null | undefined;

export interface ApiFetchInit {
  method?: ApiMethod;
  /** JSON-encoded request body. */
  body?: unknown;
  /** Appended as ?key=value (null/undefined skipped). */
  query?: Record<string, QueryValue>;
}

/** An /api path with ?key=value appended (null/undefined skipped), e.g. for a connect link. */
export function apiUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

/** Call an /api route; resolves to the JSON body or throws ApiError. */
export async function apiFetch<T>(
  path: string,
  init: ApiFetchInit = {},
): Promise<T> {
  const hasBody = init.body !== undefined;
  const res = await fetch(apiUrl(path, init.query), {
    method: init.method ?? (hasBody ? "POST" : "GET"),
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const body = (data ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, {
      error: body.error ?? `Request failed (${res.status})`,
      problems: body.problems,
      conflict: body.conflict,
      restoreTreasuryId: body.restoreTreasuryId,
    });
  }
  return data as T;
}

/** User-facing message for any error, with per-item problems appended. */
export function describeApiError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const problems = err.body.problems;
    return problems && problems.length > 0
      ? `${err.message}: ${problems.join("; ")}`
      : err.message;
  }
  return errorMessage(err, fallback);
}
