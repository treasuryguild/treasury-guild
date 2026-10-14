// Cast (or change) a vote: the ballot text signed by the session wallet.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { castVoteSchema } from "@/lib/api/schemas";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { castBallot } from "@/lib/governance/vote";

export const POST = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, castVoteSchema);
  await enforceRateLimit("proposalVote", session.wallet);
  return { ...(await castBallot(params.id, session.wallet, body)) };
});
