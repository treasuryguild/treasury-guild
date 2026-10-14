// The signed tally of a proposal as a JSON file (src/lib/governance/tallyDocument.ts):
// the proposal, its rules, the electorate and every signed ballot, hashed.
// Only once members can see the ballots (voting closed, or results shown live).
// A final proposal's frozen document (migration 0059) is served byte for
// byte as stored; before the freeze the document is built live.
import { NextResponse } from "next/server";
import { sessionRoute } from "@/lib/api/route";
import { requireMember } from "@/lib/authz";
import { communitySlug } from "@/lib/db/communities";
import { loadProposal, loadProposalBallots, loadTallyDocument } from "@/lib/db/governance";
import { appUrl } from "@/lib/env.server";
import { ConflictError } from "@/lib/errors";
import { ballotsVisible } from "@/lib/governance/lifecycle";
import { buildTallyDocument, tallyDocumentText } from "@/lib/governance/tallyDocument";

export const GET = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const proposal = await loadProposal(params.id);
  await requireMember(proposal.community_id, session.wallet);
  if (!ballotsVisible(proposal)) throw new ConflictError("Ballots stay hidden until voting closes");
  const community = await communitySlug(proposal.community_id);
  const frozen = await loadTallyDocument(proposal.id);
  const text = frozen?.document ?? tallyDocumentText(buildTallyDocument({
    app: new URL(appUrl()).host,
    community,
    proposal,
    ...(await loadProposalBallots(proposal.id)),
  }));
  return new NextResponse(text, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${community}-proposal-${proposal.number}-tally.json"`,
      "Cache-Control": "no-store",
    },
  });
});
