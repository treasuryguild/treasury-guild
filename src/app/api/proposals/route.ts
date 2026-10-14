// Make a proposal: a decision, or budget changes (with budget consent on,
// the Budgets page sends its saves here instead of /api/budgets).
import { parseJson, sessionRoute } from "@/lib/api/route";
import { createProposalSchema } from "@/lib/api/schemas";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { makeProposal } from "@/lib/governance/propose";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, createProposalSchema);
  await enforceRateLimit("proposalCreate", session.wallet);
  return { ...(await makeProposal(body, session.wallet)) };
});
