// Login challenges (auth_nonces): several may be open per address (migration
// 0063), so a request for someone else's address never replaces the one they
// are signing. Verify names the challenge it signed; expired ones are purged
// by the reconcile sweep.
import "server-only";

import { check, maybe, rows, serviceClient } from "./client";

export async function saveNonce(address: string, nonce: string, expiresAt: string): Promise<void> {
  check(
    await serviceClient().from("auth_nonces").insert({ address, nonce, expires_at: expiresAt }),
    "issue nonce",
  );
}

/** The address's challenge with this text, if it was issued. */
export async function loadNonce(address: string, nonce: string): Promise<{ nonce: string; expires_at: string } | null> {
  return maybe<{ nonce: string; expires_at: string }>(
    await serviceClient()
      .from("auth_nonces")
      .select("nonce, expires_at")
      .eq("address", address)
      .eq("nonce", nonce)
      .maybeSingle(),
    "load nonce",
  );
}

/** Delete this challenge; false when another request consumed it first. */
export async function consumeNonce(address: string, nonce: string): Promise<boolean> {
  const consumed = rows<{ address: string }>(
    await serviceClient()
      .from("auth_nonces")
      .delete()
      .eq("address", address)
      .eq("nonce", nonce)
      .select("address"),
    "consume nonce",
  );
  return consumed.length > 0;
}

/** Drop challenges that expired (reconcile sweep). */
export async function purgeExpiredNonces(now: Date): Promise<void> {
  check(
    await serviceClient().from("auth_nonces").delete().lt("expires_at", now.toISOString()),
    "purge expired nonces",
  );
}
