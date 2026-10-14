import { parseJson, sessionRoute } from "@/lib/api/route";
import { registerContributorSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { ensureContributor } from "@/lib/db/membership";
import { enforceRateLimit } from "@/lib/db/rateLimit";

// Ensure a contributor row exists for a wallet address (so tasks can be
// assigned to wallets that have never logged in). Any authenticated user may
// register an address; the handle stays owned by the wallet itself (RLS).
export const POST = sessionRoute(async (req, { session }) => {
  const { address } = await parseJson(req, registerContributorSchema);
  await enforceRateLimit("contributorRegister", session.wallet);
  await ensureContributor(address);
  return { ok: true } satisfies OkResponse;
});
