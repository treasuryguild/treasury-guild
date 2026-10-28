"use client";

// Community Integrations hub: sole place to connect Discord, announcement
// channel, payout webhooks, Zoom and Meet; status rows for GitHub, linked
// meetings and published records. Sections collapse when healthy.
import Link from "next/link";
import { use } from "react";
import { apiFetch } from "@/lib/api/client";
import type {
  GovernanceDiscordResponse,
  TreasuryDiscordWebhooksResponse,
} from "@/lib/api/types";
import { IntegrationCard } from "@/components/calls/IntegrationCard";
import { GovernanceDiscordControl } from "@/components/governance/GovernanceDiscordControl";
import { IntegrationSection } from "@/components/integrations/IntegrationSection";
import { DiscordWebhookControl } from "@/components/treasury/DiscordWebhookControl";
import { ErrorText, PageTitle } from "@/components/ui";
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

  const discordConnected = data?.discord.serverConnected ?? false;
  const channelSet = Boolean(data?.discord.channelId);
  const webhookTreasuries = data?.payoutDiscord.treasuries ?? [];
  const webhooksConnected = webhookTreasuries.filter((t) => t.webhookConnected).length;
  const webhooksIncomplete =
    webhookTreasuries.length === 0 || webhooksConnected < webhookTreasuries.length;
  const githubIncomplete =
    !data || data.github.installationCount === 0 || data.github.workgroupsMissingRepo > 0 || !data.github.archiveReady;
  const callsIncomplete = !data || (!data.calls.zoomConnected && !data.calls.googleConnected);
  const zoomIncomplete = !data?.calls.zoomConnected;
  const googleIncomplete = !data?.calls.googleConnected;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageTitle>Integrations</PageTitle>
      <p className="-mt-3 text-sm text-zinc-400">
        Connect Discord, Zoom and Meet for this community, and pick announcement channels and
        payout webhooks. Voting rules stay under Governance; linked meetings under Call platforms;
        install the GitHub App under GitHub.
      </p>
      <ErrorText error={status.error} />

      <IntegrationSection
        id="discord"
        title="Discord server"
        incomplete={!discordConnected}
        status={discordConnected
          ? (data?.discord.serverLabel ?? "Connected")
          : "Not connected"}
      >
        <IntegrationCard
          embedded
          communityId={community!.id}
          provider="discord"
          title="Discord server"
          apiPath="/api/discord/guild-connect"
          outcomeParam="discord_server"
          returnTo={returnTo}
          onChanged={reloadAll}
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
      </IntegrationSection>

      <IntegrationSection
        id="announcements"
        title="Proposal announcements"
        incomplete={discordConnected && !channelSet}
        status={!discordConnected
          ? "Needs Discord server"
          : channelSet
            ? "Channel connected"
            : "No channel"}
      >
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
        <ErrorText error={discord.error} />
      </IntegrationSection>

      <IntegrationSection
        id="payout-webhooks"
        title="Payout Discord webhooks"
        incomplete={webhooksIncomplete}
        status={webhookTreasuries.length === 0
          ? "No treasury yet"
          : `${webhooksConnected}/${webhookTreasuries.length} connected`}
      >
        <p className="text-sm text-zinc-400">
          Each treasury can post confirmed payouts to a Discord channel via an incoming webhook
          (Channel settings → Integrations → Webhooks). This is separate from the bot above.
        </p>
        <ErrorText error={webhooks.error} />
        {webhookTreasuries.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No treasury yet.{" "}
            <Link className="underline" href={routes.treasury(slug)}>Create one</Link>
            {" "}first.
          </p>
        ) : (
          webhookTreasuries.map((t) => (
            <div key={t.treasuryId} className="rounded-lg border border-zinc-800 px-3 py-2">
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
          <p className="text-sm text-zinc-500">
            Optional: set the fiat rate shown in payout footers on{" "}
            <Link className="underline" href={routes.members(slug)}>Members</Link>.
          </p>
        )}
      </IntegrationSection>

      <IntegrationSection
        id="zoom"
        title="Zoom account"
        incomplete={zoomIncomplete}
        status={data?.calls.zoomConnected ? "Connected" : "Not connected"}
      >
        <IntegrationCard
          embedded
          communityId={community!.id}
          provider="zoom"
          title="Zoom account"
          apiPath="/api/zoom/connect"
          outcomeParam="zoom"
          returnTo={returnTo}
          onChanged={reloadAll}
          nouns={{ thing: "account", connect: "Connect Zoom account", change: "Change account" }}
          blurb={<>
            Connect the Zoom account that hosts your community&apos;s calls. Zoom then tells Guild
            Vault who joins and leaves its meetings, and how long they stayed; only the meetings
            you list as calls, or link under Call platforms, become visible to members. Only
            meetings hosted by this account can be captured, so use one shared account.
          </>}
          footnote={<>
            Zoom attendees are mostly guests known by the name they typed: a name that matches a
            member, or one you linked before, arrives with its wallet, the rest wait for one. The
            final minutes come from Zoom&apos;s participant report, which needs a paid Zoom plan; on a
            free plan the live join and leave events still count.
          </>}
          disconnectWarning={<>
            Capture stops for this community&apos;s Zoom calls and the stored access is deleted.
            Attendees already captured stay on their calls.
          </>}
        />
      </IntegrationSection>

      <IntegrationSection
        id="google"
        title="Google Meet account"
        incomplete={googleIncomplete}
        status={data?.calls.googleConnected ? "Connected" : "Not connected"}
      >
        <IntegrationCard
          embedded
          communityId={community!.id}
          provider="google"
          title="Google Meet account"
          apiPath="/api/google/host-connect"
          outcomeParam="google_host"
          returnTo={returnTo}
          onChanged={reloadAll}
          nouns={{ thing: "account", connect: "Connect Google account", change: "Change account" }}
          blurb={<>
            Connect the Google account that creates your community&apos;s Meet calls. Treasury Guild
            then reads who attended the meetings you list on the Calls page, and for how long. It
            asks for one permission, reading your meetings&apos; attendance: no audio, video, chat,
            recordings or calendar. Meet only reports a meeting to the account that created it, so
            create rewarded calls from this one account.
          </>}
          footnote={<>
            Tick the Meet permission on Google&apos;s screen, or the connection is refused
            (meet_permission_not_granted). Attendees signed in to Google are recognised by the
            Google account they linked on their Profile page; guests show up by name, waiting for a
            wallet.
          </>}
          disconnectWarning={<>
            Capture stops for this community&apos;s Meet calls, the stored access is deleted and
            revoked at Google. Attendees already captured stay on their calls.
          </>}
        />
      </IntegrationSection>

      <IntegrationSection
        id="github"
        title="GitHub"
        incomplete={githubIncomplete}
        status={!data
          ? "…"
          : data.github.installationCount === 0
            ? "Not installed"
            : `${data.github.installationCount} install${data.github.installationCount === 1 ? "" : "s"}, ${data.github.linkedRepoCount} repo${data.github.linkedRepoCount === 1 ? "" : "s"}`}
      >
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
        <p className="text-sm">
          <Link className="text-indigo-400 hover:underline" href={routes.githubSettings(slug)}>
            Open GitHub settings
          </Link>
        </p>
      </IntegrationSection>

      <IntegrationSection
        id="call-platforms"
        title="Linked meetings"
        incomplete={callsIncomplete || (data != null && data.calls.linkedMeetingCount === 0 && (data.calls.zoomConnected || data.calls.googleConnected))}
        status={!data
          ? "…"
          : `Zoom ${data.calls.zoomConnected ? "on" : "off"} · Meet ${data.calls.googleConnected ? "on" : "off"} · ${data.calls.linkedMeetingCount} linked`}
      >
        <p className="text-sm text-zinc-400">
          Zoom and Meet accounts are connected in the sections above. Recurring meetings that
          should create calls automatically are linked under Call platforms. Discord voice uses the
          Discord server above.
        </p>
        <p className="text-sm">
          <Link className="text-indigo-400 hover:underline" href={routes.callSettings(slug)}>
            Open Call platforms
          </Link>
        </p>
      </IntegrationSection>

      <IntegrationSection
        id="records"
        title="Records and checks"
        incomplete={Boolean(data?.records.anyKindEnabled && !data.records.documentStore)}
        status={!data
          ? "…"
          : data.records.documentStore
            ? STORE_LABELS[data.records.documentStore]
            : "In app only"}
      >
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
        <p className="text-sm">
          <Link className="text-indigo-400 hover:underline" href={routes.governanceSettings(slug)}>
            Open Governance settings
          </Link>
        </p>
      </IntegrationSection>
    </div>
  );
}
