"use client";

// Call platforms: linked meetings only. Zoom / Meet / Discord host connections
// live under Integrations; this page shows their status and links there.
import { use } from "react";
import { routes } from "@/lib/routes";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useIntegrationsStatus } from "@/hooks/useIntegrationsStatus";
import { LinkedMeetingsCard } from "@/components/calls/LinkedMeetingsCard";
import { IntegrationStatusLink } from "@/components/integrations/IntegrationStatusLink";
import { Card, PageTitle, SectionTitle } from "@/components/ui";

export default function CallSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, blocked } = useCommunityGate(slug, { require: "admin" });
  const status = useIntegrationsStatus(community?.id);
  if (blocked) return blocked;

  const calls = status.data?.calls;
  const discord = status.data?.discord;

  return (
    <div className="max-w-2xl space-y-4">
      <PageTitle>Call platforms</PageTitle>
      <p className="-mt-3 mb-2 text-sm text-zinc-400">
        Link recurring Zoom or Meet meetings so attendance creates calls automatically. Connect
        host accounts and the Discord server under Integrations. Check-in and pasted lists on the
        Calls page work without any connection.
      </p>

      <Card>
        <SectionTitle>Host connections</SectionTitle>
        <div className="mt-3 space-y-2">
          <IntegrationStatusLink
            label="Discord voice"
            href={`${routes.integrations(slug)}#discord`}
            status={!discord ? "…" : discord.serverConnected
              ? (discord.serverLabel ?? "Connected")
              : "Not connected"}
          />
          <IntegrationStatusLink
            label="Zoom"
            href={`${routes.integrations(slug)}#zoom`}
            status={!calls ? "…" : calls.zoomConnected ? "Connected" : "Not connected"}
          />
          <IntegrationStatusLink
            label="Google Meet"
            href={`${routes.integrations(slug)}#google`}
            status={!calls ? "…" : calls.googleConnected ? "Connected" : "Not connected"}
          />
        </div>
      </Card>

      <LinkedMeetingsCard communityId={community!.id} />
    </div>
  );
}
