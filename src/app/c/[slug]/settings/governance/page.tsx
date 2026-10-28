"use client";

// Governance settings: per proposal kind, whether it is on, who proposes,
// who votes and how. Admins edit; every member can read the rules and the
// log of changes to them. Discord announcement channel is configured under
// Integrations — this page only shows status.
import { use } from "react";
import { Card, ErrorText, PageTitle, SectionTitle } from "@/components/ui";
import { GovernanceKindCard } from "@/components/governance/GovernanceKindCard";
import { RecordsAndChecksCard } from "@/components/governance/RecordsAndChecksCard";
import { IntegrationStatusLink } from "@/components/integrations/IntegrationStatusLink";
import { apiFetch } from "@/lib/api/client";
import type { GovernanceCommunitySettingsResponse } from "@/lib/api/types";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useIntegrationsStatus } from "@/hooks/useIntegrationsStatus";
import { formatDate } from "@/lib/format";
import { describeSettingChange, voterName } from "@/lib/governance/labels";
import { LIVE_PROPOSAL_KINDS } from "@/lib/governance/rules";
import { routes } from "@/lib/routes";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useGovernanceChanges, useGovernanceSettings } from "@/hooks/useProposals";

export default function GovernanceSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const settings = useGovernanceSettings(community?.id);
  const changes = useGovernanceChanges(community?.id);
  const members = useCommunityMembers(community?.id);
  const integrations = useIntegrationsStatus(isAdmin ? community?.id : null);
  const communitySettings = useAsyncData(community?.id, () =>
    apiFetch<GovernanceCommunitySettingsResponse>("/api/governance/community-settings", { query: { communityId: community!.id } }));

  if (blocked) return blocked;
  const handle = (wallet: string) => members.data?.find((m) => m.wallet_address === wallet)?.contributors?.handle;
  const discord = integrations.data?.discord;

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
        <GovernanceKindCard key={kind} communityId={community.id} kind={kind} slug={slug}
          initial={settings.data![kind]} canEdit={isAdmin} onSaved={() => { settings.reload(); changes.reload(); }} />
      ))}
      {community && communitySettings.data && (
        <RecordsAndChecksCard key={communitySettings.data.settings.documentStore ?? "none"} communityId={community.id}
          slug={slug} initial={communitySettings.data.settings} canEdit={isAdmin}
          onSaved={() => { communitySettings.reload(); changes.reload(); }} />
      )}
      <ErrorText error={communitySettings.error} />
      {isAdmin && community && (
        <Card>
          <SectionTitle>Discord announcements</SectionTitle>
          <p className="mb-3 text-sm text-zinc-400">
            Proposal milestones post to a Discord channel when one is chosen under Integrations
            (forum channels work best for discussion threads).
          </p>
          <IntegrationStatusLink
            label="Announcement channel"
            href={`${routes.integrations(slug)}#announcements`}
            status={
              !discord
                ? "…"
                : !discord.serverConnected
                  ? "Discord server not connected"
                  : discord.channelId
                    ? (discord.serverLabel ? `${discord.serverLabel} · channel connected` : "Channel connected")
                    : "No channel chosen"
            }
          />
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
