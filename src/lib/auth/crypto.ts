// Server-side secret comparisons: HMAC signing and a constant-time equality
// that never throws (timingSafeEqual does on a length mismatch).
import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function sha256Hex(message: string): string {
  return createHash("sha256").update(message).digest("hex");
}

/** Constant-time string equality (for equal lengths; a length mismatch is simply false). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
