// Assemble IntegrationsStatus for a community (service role). Admins only at
// the route; this module does not authorize.
import "server-only";

import { IntegrationProvider, TaskSource } from "@/lib/constants";
import { loadIntegration, loadMeetingLinks } from "@/lib/db/callCapture";
import { rows, serviceClient } from "@/lib/db/client";
import { requireCommunity } from "@/lib/db/communities";
import { loadGovernanceCommunitySettings } from "@/lib/db/governance";
import { communityInstallations, loadInstallationRepoLinks } from "@/lib/db/github";
import { listCommunityTreasuries, listTreasuryDiscordWebhooks } from "@/lib/db/treasuries";
import { listCommunityWorkgroups } from "@/lib/db/workgroups";
import { loadGovernanceDiscordStatus } from "@/lib/discord/notifyProposals";
import { buildIntegrationsStatus, type IntegrationsStatus } from "./status";

async function githubLinkStats(communityId: string): Promise<{
  installationCount: number;
  linkedRepoCount: number;
  linkedWorkgroupIds: Set<string>;
}> {
  const installations = await communityInstallations(communityId);
  const linkedWorkgroupIds = new Set<string>();
  let linkedRepoCount = 0;
  for (const installation of installations) {
    const repos = await loadInstallationRepoLinks(installation.installation_id);
    for (const repo of repos) {
      if (!repo.workgroup_id) continue;
      linkedRepoCount += 1;
      linkedWorkgroupIds.add(repo.workgroup_id);
    }
  }
  return { installationCount: installations.length, linkedRepoCount, linkedWorkgroupIds };
}

async function anyKindEnabled(communityId: string): Promise<boolean> {
  const enabled = rows<{ enabled: boolean }>(
    await serviceClient()
      .from("governance_settings")
      .select("enabled")
      .eq("community_id", communityId)
      .eq("enabled", true)
      .limit(1),
    "load enabled governance kinds",
  );
  return enabled.length > 0;
}

export async function loadIntegrationsStatus(communityId: string): Promise<IntegrationsStatus> {
  const community = await requireCommunity(communityId);
  const [
    discord,
    treasuries,
    webhooks,
    github,
    workgroups,
    zoom,
    google,
    meetingLinks,
    communitySettings,
    kindsOn,
  ] = await Promise.all([
    loadGovernanceDiscordStatus(communityId),
    listCommunityTreasuries(communityId),
    listTreasuryDiscordWebhooks(communityId),
    githubLinkStats(communityId),
    listCommunityWorkgroups(communityId),
    loadIntegration(communityId, IntegrationProvider.Zoom),
    loadIntegration(communityId, IntegrationProvider.Google),
    loadMeetingLinks(communityId),
    loadGovernanceCommunitySettings(communityId),
    anyKindEnabled(communityId),
  ]);

  const githubWorkgroups = workgroups.filter(
    (w) => w.kind === TaskSource.Github && !w.archived_at,
  );
  const workgroupsMissingRepo = githubWorkgroups.filter(
    (w) => !github.linkedWorkgroupIds.has(w.id),
  ).length;

  return buildIntegrationsStatus({
    discord: {
      serverConnected: discord.serverConnected,
      serverLabel: discord.serverLabel,
      channelId: discord.channelId,
      lastError: discord.lastError,
    },
    treasuries: treasuries.map((t) => ({ id: t.id, name: t.name })),
    webhookTreasuryIds: webhooks.map((w) => w.treasury_id),
    rateConfigured: community.discord_rate_coin !== null,
    github: {
      installationCount: github.installationCount,
      linkedRepoCount: github.linkedRepoCount,
      workgroupsMissingRepo,
      documentStore: communitySettings.documentStore,
      documentArchiveRepoId: communitySettings.documentArchiveRepoId,
    },
    calls: {
      zoomConnected: !!zoom,
      googleConnected: !!google,
      linkedMeetingCount: meetingLinks.length,
    },
    spendCheck: communitySettings.spendCheck,
    anyKindEnabled: kindsOn,
  });
}
