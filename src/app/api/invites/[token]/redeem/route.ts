// Redeem an invite: the signed-in wallet joins the community as a member.
import { parseInput } from "@/lib/api/parse";
import { sessionRoute } from "@/lib/api/route";
import { inviteTokenSchema } from "@/lib/api/schemas";
import type { RedeemInviteResponse } from "@/lib/api/types";
import { redeemInvite } from "@/lib/db/invites";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const POST = sessionRoute<{ token: string }>(async (_req, { params, session }) => {
  const token = parseInput(inviteTokenSchema, params.token);
  await enforceRateLimit("inviteRedeem", session.wallet);
  const result = await redeemInvite(token, session.wallet);
  return {
    ok: true,
    slug: result.slug,
    name: result.name,
    already: result.already,
  } satisfies RedeemInviteResponse;
});
