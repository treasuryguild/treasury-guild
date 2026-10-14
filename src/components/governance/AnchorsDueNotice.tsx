"use client";

// "Anchors due": the proposal steps not yet on-chain. The next payout or
// payment built in the community carries them by itself; a treasury actor
// can also build a dedicated anchor transaction now. Nothing shows while
// nothing is due. On the Proposals and Treasury pages.
import Link from "next/link";
import type { TreasurySummary } from "@/lib/db/types";
import { plural } from "@/lib/format";
import { routes } from "@/lib/routes";
import { useAnchorsDue } from "@/hooks/useProposals";
import { Card } from "@/components/ui";
import { BuildAnchorButton } from "./BuildAnchorButton";

export function AnchorsDueNotice({ slug, communityId, treasuries, isAdmin }: {
  slug: string;
  communityId: string;
  treasuries: readonly TreasurySummary[] | null;
  isAdmin: boolean;
}) {
  const due = useAnchorsDue(communityId);
  if (!due.data || due.data.length === 0 || treasuries === null) return null;
  const steps = due.data.reduce((n, p) => n + p.steps.length, 0);
  return (
    <Card className="border-indigo-500/30">
      <h3 className="mb-1 text-sm font-medium">On-chain anchors due</h3>
      <p className="mb-3 text-sm text-zinc-400">
        {plural(steps, "anchor")} for {plural(due.data.length, "proposal")} (
        {due.data.map((p, i) => (
          <span key={p.proposalId}>
            {i > 0 && ", "}
            <Link className="underline" href={routes.proposal(slug, p.proposalId)}>#{p.number}</Link>
          </span>
        ))}
        ) {steps === 1 ? "is" : "are"} not on-chain yet. The next payout or payment built in this community carries
        {steps === 1 ? " it" : " them"}; or put {steps === 1 ? "it" : "them"} on-chain now with a transaction that moves no funds.
      </p>
      <BuildAnchorButton slug={slug} communityId={communityId} treasuries={treasuries} isAdmin={isAdmin} />
    </Card>
  );
}
