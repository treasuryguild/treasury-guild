import { NextResponse } from "next/server";
import { clientIp, parseJson, publicRoute } from "@/lib/api/route";
import { authVerifySchema } from "@/lib/api/schemas";
import type { AuthVerifyResponse } from "@/lib/api/types";
import {
  mintSessionJwt,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth/jwt";
import { verifyWalletSignature } from "@/lib/auth/walletSignature";
import { consumeNonce, loadNonce } from "@/lib/db/auth";
import { ensureContributor } from "@/lib/db/membership";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { isProduction } from "@/lib/env.server";
import { UnauthorizedError } from "@/lib/errors";

export const POST = publicRoute(async (req) => {
  const { address, nonce, key, signature } = await parseJson(req, authVerifySchema);
  await enforceRateLimit("authVerifyIp", clientIp(req));

  const nonceRow = await loadNonce(address, nonce);
  if (!nonceRow || new Date(nonceRow.expires_at) < new Date()) {
    throw new UnauthorizedError("Nonce expired");
  }

  const valid = await verifyWalletSignature(nonceRow.nonce, { key, signature }, address);
  // A bad signature leaves the challenge alone: anyone can post one for any
  // address, and burning the nonce would lock its owner out. A good one
  // consumes it atomically, so two requests replaying it cannot both win.
  if (!valid) throw new UnauthorizedError("Invalid signature");
  if (!(await consumeNonce(address, nonceRow.nonce))) throw new UnauthorizedError("Nonce expired");

  // A real insert means this wallet has never signed in: start onboarding.
  const { created: firstLogin } = await ensureContributor(address);

  const token = await mintSessionJwt(address);
  const res = NextResponse.json({
    wallet: address,
    firstLogin,
  } satisfies AuthVerifyResponse);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
});
