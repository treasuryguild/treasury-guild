import { publicRoute } from "@/lib/api/route";
import type { SessionTokenResponse } from "@/lib/api/types";
import { mintAccessJwt } from "@/lib/auth/jwt";
import { isDevWallet } from "@/lib/dev/access";
import { devWallets } from "@/lib/env.server";

// Same-origin route giving the browser Supabase client (its accessToken
// callback) a token for RLS with the wallet claim. It is a fresh short-lived
// JWT, never the session cookie itself: the cookie is httpOnly, and the
// client re-fetches here as the token nears expiry.
export const GET = publicRoute(async (_req, { session }) => {
  if (!session) {
    return { token: null, wallet: null, developer: false } satisfies SessionTokenResponse;
  }
  return {
    token: await mintAccessJwt(session.wallet),
    wallet: session.wallet,
    developer: isDevWallet(session.wallet, devWallets()),
  } satisfies SessionTokenResponse;
});
