"use client";

// What a workgroup proposal creates when it passes, and a link to it once it did.
import Link from "next/link";
import { Card, SectionTitle } from "@/components/ui";
import type { ProposalRow } from "@/lib/db/types";
import { voterName } from "@/lib/governance/labels";
import { isWorkgroupPayload } from "@/lib/governance/payload";
import { routes } from "@/lib/routes";

export function WorkgroupProposalView({ slug, proposal, names }: {
  slug: string;
  proposal: ProposalRow;
  names: Map<string, string | null>;
}) {
  if (!isWorkgroupPayload(proposal.payload)) return null;
  const { workgroup, columns } = proposal.payload;
  const created = proposal.execution_result?.workgroupId;
  return (
    <Card>
      <SectionTitle action={created ? <Link className="text-sm underline" href={routes.board(slug, created)}>Open its board</Link> : undefined}>
        New workgroup
      </SectionTitle>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-zinc-500">Name</dt>
        <dd className="font-medium">{workgroup.name}</dd>
        {workgroup.description && <>
          <dt className="text-zinc-500">Description</dt>
          <dd className="whitespace-pre-wrap">{workgroup.description}</dd>
        </>}
        <dt className="text-zinc-500">Leads</dt>
        <dd>{workgroup.leads.length ? workgroup.leads.map((w) => voterName(w, names.get(w))).join(", ") : "None: admins add them later"}</dd>
        <dt className="text-zinc-500">Board</dt>
        <dd>App board with {columns.map((c) => c.name).join(", ")}</dd>
      </dl>
      <p className="mt-4 text-xs text-zinc-500">
        Created when the proposal passes, unless an active workgroup has taken the name by then. A proposed lead who has left
        the community is skipped.
      </p>
    </Card>
  );
}
