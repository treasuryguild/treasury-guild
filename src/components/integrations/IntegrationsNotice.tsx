"use client";

// Admin-only soft banner for a specific Integrations gap on a feature page.
import Link from "next/link";
import { useIntegrationsStatus } from "@/hooks/useIntegrationsStatus";
import type { IntegrationsStatus } from "@/lib/integrations/status";
import { routes } from "@/lib/routes";

export type IntegrationsNoticeKind = "proposals-channel" | "treasury-webhooks" | "payday-webhooks";

function message(
  kind: IntegrationsNoticeKind,
  status: IntegrationsStatus,
  slug: string,
): { text: string; href: string } | null {
  switch (kind) {
    case "proposals-channel":
      if (!status.discord.serverConnected || status.discord.channelId) return null;
      return {
        text: "Proposals will not post to Discord until you pick an announcement channel.",
        href: `${routes.integrations(slug)}#announcements`,
      };
    case "treasury-webhooks": {
      const missing = status.payoutDiscord.treasuries.filter((t) => !t.webhookConnected);
      if (missing.length === 0) return null;
      return {
        text: missing.length === status.payoutDiscord.treasuries.length
          ? "Confirmed payouts are not announced in Discord — add a webhook per treasury."
          : `${missing.length} treasur${missing.length === 1 ? "y has" : "ies have"} no Discord payout webhook.`,
        href: `${routes.integrations(slug)}#payout-webhooks`,
      };
    }
    case "payday-webhooks": {
      if (status.treasuryCount === 0) return null;
      const any = status.payoutDiscord.treasuries.some((t) => t.webhookConnected);
      if (any) return null;
      return {
        text: "Confirmed payouts are not announced in Discord — connect a webhook under Integrations.",
        href: `${routes.integrations(slug)}#payout-webhooks`,
      };
    }
  }
}

export function IntegrationsNotice({
  communityId,
  slug,
  kind,
}: {
  communityId: string;
  slug: string;
  kind: IntegrationsNoticeKind;
}) {
  const status = useIntegrationsStatus(communityId);
  if (!status.data) return null;
  const notice = message(kind, status.data, slug);
  if (!notice) return null;

  return (
    <p className="mb-4 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
      {notice.text}{" "}
      <Link className="underline" href={notice.href}>Open Integrations</Link>
    </p>
  );
}
