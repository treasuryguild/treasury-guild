"use client";

// Community Integrations hub: Discord server install (moved from Call
// platforms), announcement channel, per-treasury payout webhooks, and status
// rows for GitHub, call platforms and published records.
import Link from "next/link";
import { use } from "react";
import { apiFetch } from "@/lib/api/client";
import type {
  GovernanceDiscordResponse,
  TreasuryDiscordWebhooksResponse,
} from "@/lib/api/types";
import { IntegrationCard } from "@/components/calls/IntegrationCard";
import { GovernanceDiscordControl } from "@/components/governance/GovernanceDiscordControl";
import { DiscordWebhookControl } from "@/components/treasury/DiscordWebhookControl";
import { Card, ErrorText, PageTitle, SectionTitle } from "@/components/ui";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useIntegrationsStatus } from "@/hooks/useIntegrationsStatus";
import { STORE_LABELS } from "@/lib/storage/locator";
import { routes } from "@/lib/routes";

export default function IntegrationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, blocked } = useCommunityGate(slug, { require: "admin" });
  const status = useIntegrationsStatus(community?.id);
  const discord = useAsyncData(community?.id, async () =>
    apiFetch<GovernanceDiscordResponse>("/api/governance/discord", {
      query: { communityId: community!.id },
    }));
  const webhooks = useAsyncData(community?.id, async () =>
    apiFetch<TreasuryDiscordWebhooksResponse>("/api/treasury/discord", {
      query: { communityId: community!.id },
    }));

  if (blocked) return blocked;

  const returnTo = routes.integrations(slug);
  const data = status.data;

  function reloadAll() {
    status.reload();
    discord.reload();
    webhooks.reload();
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageTitle>Integrations</PageTitle>
      <p className="-mt-3 text-sm text-zinc-400">
        Connect Discord for this community and see whether GitHub, call platforms and published
        records are finished. Voting rules stay under Governance; Zoom and Meet under Call platforms.
      </p>
      <ErrorText error={status.error} />

      <div id="discord">
        <IntegrationCard
          communityId={community!.id}
          provider="discord"
          title="Discord server"
          apiPath="/api/discord/guild-connect"
          outcomeParam="discord_server"
          returnTo={returnTo}
          nouns={{ thing: "server", connect: "Connect Discord server", change: "Change server" }}
          blurb={<>
            Adds the Treasury Guild bot to a server you manage. The bot reads who is in a voice
            channel for call rewards (it never joins or listens), and posts proposal announcements,
            outside-spend alerts and anchor reminders when you pick a channel below. Payout
            announcements use a separate webhook URL per treasury.
          </>}
          footnote={<>
            A private voice channel is captured only if the bot&apos;s role may view it. Attendees
            are recognised by the Discord account they linked on their Profile page.
          </>}
          disconnectWarning={<>
            Capture stops for this community&apos;s Discord calls, proposal announcements stop, and
            the bot leaves the server (unless another community uses it). Payout webhooks are
            unchanged. Attendees already captured stay on their calls.
          </>}
        />
      </div>

      <div id="announcements" className="scroll-mt-4">
        <Card>
          <SectionTitle>Proposal announcements</SectionTitle>
          <p className="text-sm text-zinc-400">
            Post proposals to a text or forum channel on the connected server. Messages carry the
            proposal, its timing and counts, never who voted or how.
          </p>
          <GovernanceDiscordControl
            communityId={community!.id}
            slug={slug}
            status={discord.data?.discord ?? null}
            onChanged={reloadAll}
            removeText="Proposals will no longer be announced in the channel. The Discord server connection stays."
          />
          <ErrorText error={discord.error} className="mt-2" />
        </Card>
      </div>

      <div id="payout-webhooks" className="scroll-mt-4">
        <Card>
          <SectionTitle>Payout Discord webhooks</SectionTitle>
          <p className="text-sm text-zinc-400">
            Each treasury can post confirmed payouts to a Discord channel via an incoming webhook
            (Channel settings → Integrations → Webhooks). This is separate from the bot above.
          </p>
          <ErrorText error={webhooks.error} className="mt-2" />
          {(data?.payoutDiscord.treasuries ?? []).length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">
              No treasury yet.{" "}
              <Link className="underline" href={routes.treasury(slug)}>Create one</Link>
              {" "}first.
            </p>
          ) : (
            (data?.payoutDiscord.treasuries ?? []).map((t) => (
              <div key={t.treasuryId} className="mt-3 rounded-lg border border-zinc-800 px-3 py-2">
                <p className="text-sm font-medium">{t.name}</p>
                <DiscordWebhookControl
                  endpoint="/api/treasury/discord"
                  target={{ treasuryId: t.treasuryId }}
                  removeText={`Payouts from ${t.name} will no longer be announced in the channel.`}
                  status={webhooks.data?.webhooks.find((w) => w.treasuryId === t.treasuryId) ?? null}
                  onChanged={reloadAll}
                />
              </div>
            ))
          )}
          {data && data.payoutDiscord.treasuries.some((t) => t.webhookConnected) && !data.payoutDiscord.rateConfigured && (
            <p className="mt-3 text-sm text-zinc-500">
              Optional: set the fiat rate shown in payout footers on{" "}
              <Link className="underline" href={routes.members(slug)}>Members</Link>.
            </p>
          )}
        </Card>
      </div>

      <div id="github" className="scroll-mt-4">
        <Card>
          <SectionTitle>GitHub</SectionTitle>
          {data ? (
            <p className="text-sm text-zinc-400">
              {data.github.installationCount === 0
                ? "No GitHub App installed."
                : `${data.github.installationCount} installation${data.github.installationCount === 1 ? "" : "s"}, ${data.github.linkedRepoCount} linked repositor${data.github.linkedRepoCount === 1 ? "y" : "ies"}.`}
              {data.github.workgroupsMissingRepo > 0 && (
                <> {data.github.workgroupsMissingRepo} GitHub workgroup{data.github.workgroupsMissingRepo === 1 ? "" : "s"} still need a linked repo.</>
              )}
              {!data.github.archiveReady && (
                <> Publishing tallies to GitHub needs an archive repository under Governance.</>
              )}
            </p>
          ) : (
            <p className="text-sm text-zinc-500">Loading…</p>
          )}
          <p className="mt-3 text-sm">
            <Link className="text-indigo-400 hover:underline" href={routes.githubSettings(slug)}>
              Open GitHub settings
            </Link>
          </p>
        </Card>
      </div>

      <div id="call-platforms" className="scroll-mt-4">
        <Card>
          <SectionTitle>Call platforms</SectionTitle>
          {data ? (
            <p className="text-sm text-zinc-400">
              Zoom {data.calls.zoomConnected ? "connected" : "not connected"}
              {" · "}
              Google Meet {data.calls.googleConnected ? "connected" : "not connected"}
              {" · "}
              {data.calls.linkedMeetingCount} linked meeting{data.calls.linkedMeetingCount === 1 ? "" : "s"}.
              Discord voice uses the server above.
            </p>
          ) : (
            <p className="text-sm text-zinc-500">Loading…</p>
          )}
          <p className="mt-3 text-sm">
            <Link className="text-indigo-400 hover:underline" href={routes.callSettings(slug)}>
              Open Call platforms
            </Link>
          </p>
        </Card>
      </div>

      <div id="records" className="scroll-mt-4">
        <Card>
          <SectionTitle>Records and checks</SectionTitle>
          {data ? (
            <p className="text-sm text-zinc-400">
              Signed tallies:{" "}
              {data.records.documentStore
                ? `publish to ${STORE_LABELS[data.records.documentStore]}`
                : "kept in Treasury Guild only"}
              {" · "}
              Spend check: {data.records.spendCheck === "refuse" ? "refuse over-budget builds" : "warn signers"}.
            </p>
          ) : (
            <p className="text-sm text-zinc-500">Loading…</p>
          )}
          <p className="mt-3 text-sm">
            <Link className="text-indigo-400 hover:underline" href={routes.governanceSettings(slug)}>
              Open Governance settings
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
