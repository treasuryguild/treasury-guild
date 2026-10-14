"use client";

// The decisions a payout or payment record cites (`g`): "#N" linked to the
// proposal when the community has one by that number, plain otherwise (a
// record imported from a wallet this community no longer keeps, say). The
// content hash is on the link's title so a reader can compare it.
import Link from "next/link";
import type { Citation } from "@/lib/cardano/metadata";
import { routes } from "@/lib/routes";

export function CitationLinks({ slug, citations, citedProposals }: {
  slug: string;
  citations: readonly Citation[];
  /** Proposal number → id. */
  citedProposals: Record<number, string>;
}) {
  if (citations.length === 0) return null;
  return (
    <>
      {citations.map((c, i) => {
        const id = citedProposals[c.number];
        const title = `Content hash ${c.contentHash}`;
        return (
          <span key={c.number}>
            {i > 0 && ", "}
            {id ? (
              <Link href={routes.proposal(slug, id)} className="underline" title={title}>#{c.number}</Link>
            ) : (
              <span title={title}>#{c.number}</span>
            )}
          </span>
        );
      })}
    </>
  );
}
