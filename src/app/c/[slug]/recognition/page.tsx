"use client";

import { use } from "react";
import Link from "next/link";
import { Card, ErrorText, PageMessage, PageTitle, SectionTitle } from "@/components/ui";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useRecognitionSeason, useRecognitionSettings } from "@/hooks/useRecognition";
import { TIER_LABELS, type RecognitionTier } from "@/lib/recognition/score";
import { shortAddress } from "@/lib/format";
import { routes } from "@/lib/routes";
import { SeasonBadgeMintCard } from "@/components/recognition/SeasonBadgeMintCard";

export default function RecognitionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const settings = useRecognitionSettings(community?.id);
  const season = useRecognitionSeason(community?.id, settings.data);
  const members = useCommunityMembers(community?.id);

  if (blocked) return blocked;

  if (settings.data && !settings.data.enabled) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <PageTitle>Recognition</PageTitle>
        <PageMessage>
          Recognition is off.{" "}
          {isAdmin ? (
            <Link className="underline" href={routes.recognitionSettings(slug)}>Turn it on in settings</Link>
          ) : (
            "Ask an admin if this community wants to use it."
          )}
        </PageMessage>
      </div>
    );
  }

  const label = (wallet: string) => {
    const m = members.data?.find((row) => row.wallet_address === wallet);
    return m?.contributors?.handle || m?.contributors?.github_username
      ? (m.contributors?.handle ?? `@${m.contributors?.github_username}`)
      : shortAddress(wallet);
  };

  const scores = season.data?.scores ?? [];
  const ranked = !!settings.data?.showLeaderboard;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageTitle action={isAdmin ? (
        <Link className="text-sm underline" href={routes.recognitionSettings(slug)}>Settings</Link>
      ) : undefined}>
        Recognition
      </PageTitle>
      <p className="-mt-3 text-sm text-zinc-400">
        Season <span className="font-mono text-zinc-300">{season.data?.seasonKey ?? "…"}</span>
        {" "}— lead endorsements of paid work.{" "}
        <Link className="underline" href={routes.doc("recognition")}>How it works</Link>
      </p>
      <ErrorText error={settings.error ?? season.error} />
      <Card>
        <SectionTitle>This season</SectionTitle>
        {scores.length === 0 ? (
          <p className="text-sm text-zinc-500">No endorsements yet this season.</p>
        ) : (
          <ol className="space-y-2">
            {scores.map((row, i) => (
              <li key={row.wallet} className="flex items-baseline justify-between gap-3 text-sm">
                <span>
                  {ranked ? `${i + 1}. ` : ""}
                  <span className="text-zinc-200">{label(row.wallet)}</span>
                  {" "}
                  <span className="text-zinc-500">{TIER_LABELS[row.tier as RecognitionTier]}</span>
                </span>
                <span className="font-mono text-zinc-400">{row.score}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      {isAdmin && community && settings.data && season.data && (
        <SeasonBadgeMintCard
          slug={slug}
          seasonKey={season.data.seasonKey ?? ""}
          exemplars={scores.filter((s) => s.tier === "exemplar" || s.score >= 6)}
        />
      )}
    </div>
  );
}
