// Zoom webhook authenticity. Zoom signs "v0:<timestamp>:<raw body>" with the
// app's secret token (header x-zm-signature = "v0=<hex hmac>"), and proves a
// new endpoint by asking it to sign a plain token (endpoint.url_validation).
import "server-only";

import { hmacSha256Hex as hmacHex, safeEqual } from "@/lib/auth/crypto";

/** Replays older than this are refused even with a valid signature. */
const MAX_AGE_MS = 5 * 60 * 1000;

export function verifyZoomSignature(args: {
  secret: string;
  /** x-zm-request-timestamp (seconds). */
  timestamp: string | null;
  /** x-zm-signature. */
  signature: string | null;
  rawBody: string;
  now?: number;
}): boolean {
  const { secret, timestamp, signature, rawBody } = args;
  if (!timestamp || !signature) return false;
  const sentAt = Number(timestamp) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs((args.now ?? Date.now()) - sentAt) > MAX_AGE_MS) return false;
  const expected = `v0=${hmacHex(secret, `v0:${timestamp}:${rawBody}`)}`;
  return safeEqual(signature, expected);
}

/** The reply to Zoom's endpoint.url_validation challenge. */
export function zoomUrlValidationResponse(
  secret: string,
  plainToken: string,
): { plainToken: string; encryptedToken: string } {
  return { plainToken, encryptedToken: hmacHex(secret, plainToken) };
}
