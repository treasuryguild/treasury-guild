"use client";

// The label-190002 anchor record a transaction carries, decoded from its
// CBOR: one row per proposal step, each "#N" linked to the proposal when
// the community has one by that number, then the raw record with its legend.
// On a dedicated anchor transaction and on any payout or payment that
// carries anchors along.
import Link from "next/link";
import { parseAnchorMetadata, type AnchorEntry } from "@/lib/cardano/anchorMetadata";
import { anchorLegend } from "@/lib/cardano/metadataLegend";
import { shortHash } from "@/lib/format";
import { routes } from "@/lib/routes";
import { Card, InsetRow, JsonDetails } from "@/components/ui";

const STEP_LABELS = { proposed: "Proposed", opened: "Voting opened", closed: "Closed" } as const;

function describeEntry(e: AnchorEntry): string {
  switch (e[1]) {
    case "proposed":
      return `content ${shortHash(e[2], 12)} · rules ${shortHash(e[3], 12)}`;
    case "opened":
      return `voter list ${shortHash(e[2], 12)}`;
    case "closed": {
      if (e.length === 3) return e[2];
      const [electorate, ballots] = e[4];
      const copy = e.length === 6 ? ` · copy on ${e[5][0]}` : "";
      return `${e[2]} · record ${shortHash(e[3], 12)} · ${ballots} of ${electorate} voted${copy}`;
    }
  }
}

export function AnchorRecordCard({ slug, anchorMeta, citedProposals }: {
  slug: string;
  anchorMeta: unknown;
  /** Proposal number → id, for links. */
  citedProposals: Record<number, string>;
}) {
  if (anchorMeta === null || anchorMeta === undefined) return null;
  const parsed = parseAnchorMetadata(anchorMeta);
  return (
    <Card className="mb-4">
      <h3 className="mb-3 text-sm font-medium text-zinc-400">Proposal anchors</h3>
      {parsed ? (
        <div className="space-y-2">
          {parsed.a.map((entry, i) => {
            const id = citedProposals[entry[0]];
            return (
              <InsetRow key={i}>
                <span className="text-sm">
                  {id ? <Link className="underline" href={routes.proposal(slug, id)}>#{entry[0]}</Link> : <>#{entry[0]}</>}
                  <span className="ml-2 text-zinc-400">{STEP_LABELS[entry[1]]}</span>
                </span>
                <span className="text-right font-mono text-xs text-zinc-400">{describeEntry(entry)}</span>
              </InsetRow>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-zinc-500">A label-190002 value that is not a proposal anchor record (the raw value is below).</p>
      )}
      <JsonDetails label="On-chain anchor record (label 190002)" value={anchorMeta} legend={anchorLegend(anchorMeta)} />
    </Card>
  );
}
