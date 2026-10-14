// The anchor steps due in a community, grouped per proposal: what the next
// payout or payment carries, or a dedicated anchor transaction. Members read
// it (the Proposals and Treasury pages' notice, the proposal page's card).
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { communityIdQuerySchema } from "@/lib/api/schemas";
import type { AnchorsDueResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import { loadDueAnchors } from "@/lib/governance/anchorsDue";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, communityIdQuerySchema);
  await requireMember(communityId, session.wallet);
  const due = new Map<string, AnchorsDueResponse["due"][number]>();
  for (const anchor of await loadDueAnchors(communityId)) {
    const entry = due.get(anchor.proposalId) ?? { proposalId: anchor.proposalId, number: anchor.number, steps: [] };
    entry.steps.push(anchor.step);
    due.set(anchor.proposalId, entry);
  }
  return { due: [...due.values()] } satisfies AnchorsDueResponse;
});
