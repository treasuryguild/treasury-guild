// Fixed-window request limits for the abuse-prone API routes, counted in
// Postgres (`hit_rate_limit`, migration 0046) because Netlify functions share
// no memory between invocations. Budgets live in RATE_LIMITS.
import "server-only";

import { RATE_LIMIT_RETENTION_MS, RATE_LIMITS, type RateLimitBucket } from "@/lib/constants";
import { TooManyRequestsError } from "@/lib/errors";
import { check, rpc, serviceClient } from "./client";

/** Count one request of `subject` against `bucket`; 429 once over budget. */
export async function enforceRateLimit(bucket: RateLimitBucket, subject: string): Promise<void> {
  const { limit, windowSeconds } = RATE_LIMITS[bucket];
  const allowed = rpc<boolean>(
    await serviceClient().rpc("hit_rate_limit", {
      p_key: `${bucket}:${subject}`,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    }),
  );
  if (!allowed) throw new TooManyRequestsError();
}

/** Drop counters of windows that ended long ago (reconcile sweep). */
export async function purgeRateLimits(now: Date): Promise<void> {
  check(
    await serviceClient()
      .from("rate_limits")
      .delete()
      .lt("window_start", new Date(now.getTime() - RATE_LIMIT_RETENTION_MS).toISOString()),
    "purge rate limits",
  );
}
