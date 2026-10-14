// PKCE (RFC 7636), S256 only. OAuth 2.1 removes `plain`: accepting it would
// let whoever intercepts an authorization code redeem it, the very attack PKCE
// exists to stop, so it is not implemented.

import { createHash, timingSafeEqual } from "node:crypto";

/** A code_verifier is 43-128 characters of the unreserved set (RFC 7636 §4.1). */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/** A code_challenge is the base64url SHA-256 of a verifier: 43 characters, no padding. */
export function isValidCodeChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/.test(challenge);
}

/** Constant-time check that `verifier` produced `challenge`. */
export function verifyCodeChallenge(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
