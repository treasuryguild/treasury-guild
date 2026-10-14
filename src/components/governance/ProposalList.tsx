"use client";

import Link from "next/link";
import { InsetRow } from "@/components/ui";
import type { ProposalRow } from "@/lib/db/types";
import { KIND_LABELS, proposalTiming } from "@/lib/governance/labels";
import { routes } from "@/lib/routes";
import { ProposalStateBadge } from "./ProposalStateBadge";

export function ProposalList({ slug, proposals, now }: { slug: string; proposals: ProposalRow[]; now: number }) {
  return (
    <ul className="space-y-2">
      {proposals.map((p) => (
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
              <ProposalStateBadge state={p.state} />
            </InsetRow>
          </Link>
        </li>
      ))}
    </ul>
  );
}
