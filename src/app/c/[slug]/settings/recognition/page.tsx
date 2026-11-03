"use client";

import { use } from "react";
import Link from "next/link";
import { RecognitionSettingsCard } from "@/components/recognition/RecognitionSettingsCard";
import { Card, ErrorText, PageTitle, SectionTitle } from "@/components/ui";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useRecognitionSettings } from "@/hooks/useRecognition";
import { apiFetch } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { RecognitionSettingChangeRow } from "@/lib/db/types";

export default function RecognitionSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const settings = useRecognitionSettings(community?.id);
  const members = useCommunityMembers(community?.id);
  const changes = useAsyncData(community?.id, () =>
    apiFetch<{ changes: RecognitionSettingChangeRow[] }>("/api/recognition/changes", {
      query: { communityId: community!.id },
    }).then((r) => r.changes));

  if (blocked) return blocked;
  const handle = (wallet: string) =>
    members.data?.find((m) => m.wallet_address === wallet)?.contributors?.handle ?? wallet;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageTitle>Recognition</PageTitle>
      <p className="-mt-3 text-sm text-zinc-400">
        {isAdmin
          ? "Turn recognition on to let leads endorse paid work. See the "
          : "How this community recognises quality work. Admins change these rules. See the "}
        <Link className="underline" href={routes.doc("recognition")}>docs</Link>
        {settings.data?.enabled && (
          <> · <Link className="underline" href={routes.recognition(slug)}>Season board</Link></>
        )}
        .
      </p>
      <ErrorText error={settings.error} />
      {community && settings.data && (
        <RecognitionSettingsCard
          key={`${settings.data.enabled}-${settings.data.season}-${settings.data.maxEndorsementsPerActorSeason}`}
          communityId={community.id}
          initial={settings.data}
          canEdit={isAdmin}
          onSaved={() => { settings.reload(); changes.reload(); }}
        />
      )}
      <Card>
        <SectionTitle>Changes</SectionTitle>
        <ErrorText error={changes.error} />
        {(changes.data ?? []).length === 0 ? (
          <p className="text-sm text-zinc-500">No changes yet.</p>
        ) : (
          <ul className="space-y-2 text-sm text-zinc-400">
            {changes.data!.map((c) => (
              <li key={c.id}>
                {formatDate(c.changed_at)} — {handle(c.actor)}
                {c.after_value.enabled ? " enabled" : " disabled"} recognition
                ({c.after_value.season}, max {c.after_value.max_endorsements_per_actor_season})
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
