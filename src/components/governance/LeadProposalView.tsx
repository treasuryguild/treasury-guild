"use client";

import { Card } from "@/components/ui";
import type { ProposalRow } from "@/lib/db/types";
import { proposalChangeLines, type ChangeNames } from "@/lib/governance/describe";
import { isLeadPayload } from "@/lib/governance/payload";

/** What a lead change adds and removes, and which wider vote an escalation uses. */
export function LeadProposalView({ proposal, names }: {
  proposal: ProposalRow;
  names: ChangeNames;
}) {
  if (!isLeadPayload(proposal.payload)) return null;
  const lines = proposalChangeLines(proposal, names);
  const escalates = proposal.payload.leadChange.escalates;
  return (
    <Card className="space-y-2">
      {lines.map((line) => <p key={line} className="text-sm">{line}</p>)}
      {escalates !== null && <p className="text-sm text-zinc-400">Escalates #{escalates}.</p>}
    </Card>
  );
}
