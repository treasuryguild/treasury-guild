// Pure completeness model for community Integrations: one shape drives the
// hub, Overview checklist and feature-page notices. No I/O.

import type { DocumentStoreName } from "@/lib/db/types";
import type { SpendCheckMode } from "@/lib/governance/rules";

/** Stable ids for Overview checklist dismissals and deep links. */
export const SetupItemId = {
  Treasury: "treasury",
  DiscordServer: "discord_server",
  DiscordChannel: "discord_channel",
  PayoutWebhooks: "payout_webhooks",
  Github: "github",
  CallPlatform: "call_platform",
  LinkedMeetings: "linked_meetings",
  TallyPublish: "tally_publish",
  PayoutRate: "payout_rate",
} as const;
export type SetupItemId = (typeof SetupItemId)[keyof typeof SetupItemId];

export interface DiscordIntegrationStatus {
  serverConnected: boolean;
  serverLabel: string | null;
  channelId: string | null;
  lastError: string | null;
}

export interface TreasuryPayoutDiscordStatus {
  treasuryId: string;
  name: string;
  /** True when a webhook URL or bot channel is configured for this treasury. */
  connected: boolean;
}

export interface PayoutDiscordStatus {
  treasuries: TreasuryPayoutDiscordStatus[];
  /** Soft incomplete when any destination exists and the community rate coin is null. */
  rateConfigured: boolean;
}

export interface GithubIntegrationStatus {
  installationCount: number;
  linkedRepoCount: number;
  /** Active (non-archived) GitHub-kind workgroups with no linked repo. */
  workgroupsMissingRepo: number;
  /** True when document store is not github, or an archive repo is set. */
  archiveReady: boolean;
}

export interface CallsIntegrationStatus {
  zoomConnected: boolean;
  googleConnected: boolean;
  linkedMeetingCount: number;
}

export interface RecordsIntegrationStatus {
  documentStore: DocumentStoreName | null;
  spendCheck: SpendCheckMode;
  /** True when at least one proposal kind is enabled. */
  anyKindEnabled: boolean;
}

export interface SetupChecklistItem {
  id: SetupItemId;
  label: string;
  /** Soft items are dismissible suggestions; hard ones are the usual setup path. */
  soft: boolean;
}

export interface IntegrationsStatus {
  discord: DiscordIntegrationStatus;
  payoutDiscord: PayoutDiscordStatus;
  github: GithubIntegrationStatus;
  calls: CallsIntegrationStatus;
  records: RecordsIntegrationStatus;
  treasuryCount: number;
  checklist: SetupChecklistItem[];
}

export interface IntegrationsStatusInput {
  discord: DiscordIntegrationStatus;
  treasuries: { id: string; name: string }[];
  /** Treasury ids that have a payout Discord destination (webhook or channel). */
  payoutDiscordTreasuryIds: readonly string[];
  rateConfigured: boolean;
  github: {
    installationCount: number;
    linkedRepoCount: number;
    workgroupsMissingRepo: number;
    documentStore: DocumentStoreName | null;
    documentArchiveRepoId: number | null;
  };
  calls: CallsIntegrationStatus;
  spendCheck: SpendCheckMode;
  anyKindEnabled: boolean;
}

function checklistOf(input: IntegrationsStatusInput): SetupChecklistItem[] {
  const items: SetupChecklistItem[] = [];
  if (input.treasuries.length === 0) {
    items.push({ id: SetupItemId.Treasury, label: "Create or import a treasury", soft: false });
  }
  if (!input.discord.serverConnected) {
    items.push({ id: SetupItemId.DiscordServer, label: "Connect a Discord server", soft: true });
  } else if (!input.discord.channelId) {
    items.push({
      id: SetupItemId.DiscordChannel,
      label: "Pick a Discord channel for proposal announcements",
      soft: false,
    });
  }
  const missingPayoutDiscord = input.treasuries.filter(
    (t) => !input.payoutDiscordTreasuryIds.includes(t.id),
  );
  if (input.treasuries.length > 0 && missingPayoutDiscord.length > 0) {
    items.push({
      id: SetupItemId.PayoutWebhooks,
      label: missingPayoutDiscord.length === input.treasuries.length
        ? "Connect Discord so payouts are announced"
        : `Connect Discord for ${missingPayoutDiscord.length} treasur${missingPayoutDiscord.length === 1 ? "y" : "ies"}`,
      soft: true,
    });
  }
  if (
    input.payoutDiscordTreasuryIds.length > 0 &&
    !input.rateConfigured
  ) {
    items.push({
      id: SetupItemId.PayoutRate,
      label: "Set the Discord payout exchange rate (optional)",
      soft: true,
    });
  }
  if (input.github.workgroupsMissingRepo > 0) {
    items.push({
      id: SetupItemId.Github,
      label: input.github.installationCount === 0
        ? "Install the GitHub App and link repositories"
        : `Link repositories for ${input.github.workgroupsMissingRepo} GitHub workgroup${input.github.workgroupsMissingRepo === 1 ? "" : "s"}`,
      soft: false,
    });
  }
  const hasCallHost = input.calls.zoomConnected || input.calls.googleConnected;
  if (!hasCallHost) {
    items.push({
      id: SetupItemId.CallPlatform,
      label: "Connect Zoom or Google Meet for call capture",
      soft: true,
    });
  } else if (input.calls.linkedMeetingCount === 0) {
    items.push({
      id: SetupItemId.LinkedMeetings,
      label: "Link a recurring Zoom or Meet meeting",
      soft: true,
    });
  }
  if (input.anyKindEnabled && input.github.documentStore === null) {
    items.push({
      id: SetupItemId.TallyPublish,
      label: "Optionally publish signed tallies outside Treasury Guild",
      soft: true,
    });
  }
  return items;
}

/** Assemble the hub / checklist status from already-loaded facts. */
export function buildIntegrationsStatus(input: IntegrationsStatusInput): IntegrationsStatus {
  const connectedSet = new Set(input.payoutDiscordTreasuryIds);
  return {
    discord: input.discord,
    payoutDiscord: {
      treasuries: input.treasuries.map((t) => ({
        treasuryId: t.id,
        name: t.name,
        connected: connectedSet.has(t.id),
      })),
      rateConfigured: input.rateConfigured,
    },
    github: {
      installationCount: input.github.installationCount,
      linkedRepoCount: input.github.linkedRepoCount,
      workgroupsMissingRepo: input.github.workgroupsMissingRepo,
      archiveReady:
        input.github.documentStore !== "github" || input.github.documentArchiveRepoId != null,
    },
    calls: input.calls,
    records: {
      documentStore: input.github.documentStore,
      spendCheck: input.spendCheck,
      anyKindEnabled: input.anyKindEnabled,
    },
    treasuryCount: input.treasuries.length,
    checklist: checklistOf(input),
  };
}
