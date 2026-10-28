"use client";

// Governance settings: per proposal kind, whether it is on, who proposes,
// who votes and how. Admins edit; every member can read the rules and the
// log of changes to them.
import { use } from "react";
import { Card, ErrorText, PageTitle, SectionTitle } from "@/components/ui";
import { GovernanceDiscordControl } from "@/components/governance/GovernanceDiscordControl";
import { GovernanceKindCard } from "@/components/governance/GovernanceKindCard";
import { RecordsAndChecksCard } from "@/components/governance/RecordsAndChecksCard";
import { apiFetch } from "@/lib/api/client";
import type { GovernanceCommunitySettingsResponse, GovernanceDiscordResponse } from "@/lib/api/types";
import { useAsyncData } from "@/hooks/useAsyncData";
import { formatDate } from "@/lib/format";
import { describeSettingChange, voterName } from "@/lib/governance/labels";
import { LIVE_PROPOSAL_KINDS } from "@/lib/governance/rules";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useGovernanceChanges, useGovernanceSettings } from "@/hooks/useProposals";

export default function GovernanceSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const settings = useGovernanceSettings(community?.id);
  const changes = useGovernanceChanges(community?.id);
  const members = useCommunityMembers(community?.id);
  const discord = useAsyncData(isAdmin && community ? community.id : null, () =>
    apiFetch<GovernanceDiscordResponse>("/api/governance/discord", { query: { communityId: community!.id } }));
  const communitySettings = useAsyncData(community?.id, () =>
    apiFetch<GovernanceCommunitySettingsResponse>("/api/governance/community-settings", { query: { communityId: community!.id } }));

  if (blocked) return blocked;
  const handle = (wallet: string) => members.data?.find((m) => m.wallet_address === wallet)?.contributors?.handle;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageTitle>Governance</PageTitle>
      <p className="-mt-3 text-sm text-zinc-400">
        {isAdmin
          ? "Choose what the community decides by vote, and how. A proposal keeps the rules it was made with."
          : "What this community decides by vote, and how. Admins change these rules; every change is listed below."}
      </p>
      <ErrorText error={settings.error} />
      {community && settings.data && LIVE_PROPOSAL_KINDS.map((kind) => (
        <GovernanceKindCard key={kind} communityId={community.id} kind={kind}
          initial={settings.data![kind]} canEdit={isAdmin} onSaved={() => { settings.reload(); changes.reload(); }} />
      ))}
      {community && communitySettings.data && (
        <RecordsAndChecksCard key={communitySettings.data.settings.documentStore ?? "none"} communityId={community.id}
          initial={communitySettings.data.settings} canEdit={isAdmin}
          onSaved={() => { communitySettings.reload(); changes.reload(); }} />
      )}
      <ErrorText error={communitySettings.error} />
      {isAdmin && community && (
        <Card>
          <SectionTitle>Discord announcements</SectionTitle>
          <p className="text-sm text-zinc-400">
            Post proposals to a Discord channel on the server connected under Call capture: a discussion thread when a
            proposal opens (forum channels work best), when voting opens, a day before it closes, and the result.
            Messages carry the proposal, its timing and counts, never who voted or how. Proposals already under way
            are announced from their next step. Re-add the bot once if you connected it before send and thread
            permissions were added.
          </p>
          <GovernanceDiscordControl
            communityId={community.id}
            slug={slug}
            status={discord.data?.discord ?? null}
            onChanged={discord.reload}
            removeText="Proposals will no longer be announced in the channel. The Discord server connection under Call capture stays."
          />
          <ErrorText error={discord.error} className="mt-2" />
        </Card>
      )}
      <Card>
        <SectionTitle>Changes</SectionTitle>
        {changes.data?.length ? (
          <ul className="space-y-1 text-sm">
            {changes.data.map((change) => (
              <li key={change.id} className="flex flex-wrap justify-between gap-2">
                <span>{describeSettingChange(change, voterName(change.actor, handle(change.actor)))}</span>
                <span className="text-xs text-zinc-500">{formatDate(change.changed_at, "datetime")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">No changes yet: every kind uses its defaults and is off.</p>
        )}
      </Card>
    </div>
  );
}
