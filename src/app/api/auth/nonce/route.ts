import { randomUUID } from "crypto";
import { clientIp, parseJson, publicRoute } from "@/lib/api/route";
import { authNonceSchema } from "@/lib/api/schemas";
import type { AuthNonceResponse } from "@/lib/api/types";
import { saveNonce } from "@/lib/db/auth";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { appUrl } from "@/lib/env.server";

const NONCE_TTL_MS = 5 * 60_000;

export const POST = publicRoute(async (req) => {
  const { address } = await parseJson(req, authNonceSchema);
  // Unauthenticated: capped per client IP only. A per-address cap would let
  // anyone spend another wallet's budget, and a new challenge never replaces
  // an open one (several may be open per address).
  await enforceRateLimit("authNonceIp", clientIp(req));

  // The wallet shows this text when asked to sign: it names the site and the
  // address, so a challenge relayed from another site reads as such.
  const host = new URL(appUrl()).host;
  const nonce = `guild-vault login | ${host} | ${address} | ${randomUUID()} | ${new Date().toISOString()}`;
  await saveNonce(address, nonce, new Date(Date.now() + NONCE_TTL_MS).toISOString());
  return { nonce } satisfies AuthNonceResponse;
});
