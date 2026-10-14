// The ballot text for a choice, for the voter's wallet to sign (then POST /vote).
import { parseJson, sessionRoute } from "@/lib/api/route";
import { ballotRequestSchema } from "@/lib/api/schemas";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { issueBallot } from "@/lib/governance/vote";

export const POST = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, ballotRequestSchema);
  await enforceRateLimit("proposalVote", session.wallet);
  return { ...(await issueBallot(params.id, session.wallet, body)) };
});
