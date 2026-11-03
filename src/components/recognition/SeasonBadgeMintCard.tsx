"use client";

import Link from "next/link";
import { Card, SectionTitle } from "@/components/ui";
import { seasonBadgeDrafts } from "@/lib/recognition/seasonBadges";
import { shortAddress } from "@/lib/format";
import { routes } from "@/lib/routes";
import { downloadJson } from "@/lib/browser/download";

export function SeasonBadgeMintCard({
  slug,
  seasonKey,
  exemplars,
  communityName = "Community",
}: {
  slug: string;
  seasonKey: string;
  exemplars: { wallet: string; score: number }[];
  communityName?: string;
}) {
  if (!seasonKey || exemplars.length === 0) return null;

  const drafts = seasonBadgeDrafts(seasonKey, exemplars.map((e) => e.wallet), communityName);

  const download = () => {
    downloadJson(`recognition-badges-${seasonKey}.json`, drafts);
  };

  return (
    <Card>
      <SectionTitle>Season badges</SectionTitle>
      <p className="mb-3 text-sm text-zinc-400">
        {drafts.length} Exemplar{drafts.length === 1 ? "" : "s"} this season. Download a JSON
        draft of NFT metadata, then mint under the treasury policy on{" "}
        <Link className="underline" href={routes.mint(slug)}>Mint</Link>
        {" "}(up to 10 NFTs per transaction). Recognition never pays from the treasury automatically.
      </p>
      <ul className="mb-3 space-y-1 text-xs text-zinc-500">
        {drafts.map((d) => (
          <li key={d.recipientWallet}>
            <span className="font-mono text-zinc-300">{d.name}</span>
            {" → "}
            {shortAddress(d.recipientWallet)}
          </li>
        ))}
      </ul>
      <button type="button" className="text-sm text-indigo-400 underline" onClick={download}>
        Download badge drafts ↓
      </button>
    </Card>
  );
}
