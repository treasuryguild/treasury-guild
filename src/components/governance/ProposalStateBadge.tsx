import { Badge } from "@/components/ui";
import { PROPOSAL_STATE_META, type ProposalState } from "@/lib/constants";

/** proposals.state as a labelled badge. */
export function ProposalStateBadge({ state }: { state: string }) {
  const meta = PROPOSAL_STATE_META[state as ProposalState] ?? { label: state, tone: "default" as const };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}
