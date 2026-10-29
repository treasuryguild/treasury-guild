"use client";

import Link from "next/link";
import { Badge, InsetRow } from "@/components/ui";
import type { VoteChoice } from "@/lib/constants";
import type { ProposalRow } from "@/lib/db/types";
import { KIND_LABELS, proposalTiming, proposalVoteIndicator } from "@/lib/governance/labels";
import { routes } from "@/lib/routes";
import { ProposalStateBadge } from "./ProposalStateBadge";

export function ProposalList({
  slug, proposals, now, myVotes, mySeats,
}: {
  slug: string;
  proposals: ProposalRow[];
  now: number;
  myVotes?: Map<string, VoteChoice>;
  mySeats?: Map<string, { recused: boolean }>;
}) {
  return (
    <ul className="space-y-2">
      {proposals.map((p) => {
        const vote = proposalVoteIndicator(p, now, mySeats?.get(p.id), myVotes?.get(p.id));
        return (
          <li key={p.id}>
            <Link href={routes.proposal(slug, p.id)} className="block rounded-xl hover:opacity-90">
              <InsetRow>
                <div className="min-w-0">
                  <p className="truncate font-medium">#{p.number} {p.title}</p>
                  <p className="text-xs text-zinc-500">
                    {KIND_LABELS[p.kind]} · {proposalTiming(p, now)}
                    {p.electorate_size ? ` · ${p.ballots_cast} of ${p.electorate_size} voted` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {vote && <Badge tone={vote.tone}>{vote.label}</Badge>}
                  <ProposalStateBadge state={p.state} />
                </div>
              </InsetRow>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
