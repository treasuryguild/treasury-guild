"use client";

// Admin Overview strip: unfinished Integrations steps that have not been
// dismissed in this browser. Dismissing never clears the Integrations hub.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, Card, SectionTitle } from "@/components/ui";
import { useIntegrationsStatus } from "@/hooks/useIntegrationsStatus";
import { dismissSetupItem, isSetupItemDismissed } from "@/lib/integrations/checklistStorage";
import { SetupItemId, type SetupChecklistItem } from "@/lib/integrations/status";
import { routes } from "@/lib/routes";

function hrefFor(slug: string, id: SetupItemId): string {
  switch (id) {
    case SetupItemId.Treasury:
      return routes.treasury(slug);
    case SetupItemId.DiscordServer:
      return `${routes.integrations(slug)}#discord`;
    case SetupItemId.DiscordChannel:
      return `${routes.integrations(slug)}#announcements`;
    case SetupItemId.PayoutWebhooks:
      return `${routes.integrations(slug)}#payout-webhooks`;
    case SetupItemId.PayoutRate:
      return routes.members(slug);
    case SetupItemId.Github:
      return routes.githubSettings(slug);
    case SetupItemId.CallPlatform:
    case SetupItemId.LinkedMeetings:
      return routes.callSettings(slug);
    case SetupItemId.TallyPublish:
      return routes.governanceSettings(slug);
  }
}

export function SetupChecklist({
  communityId,
  slug,
}: {
  communityId: string;
  slug: string;
}) {
  const status = useIntegrationsStatus(communityId);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const items = status.data?.checklist ?? [];
    setDismissed(new Set(items.filter((i) => isSetupItemDismissed(communityId, i.id)).map((i) => i.id)));
  }, [communityId, status.data]);

  const visible: SetupChecklistItem[] = (status.data?.checklist ?? []).filter(
    (item) => !dismissed.has(item.id),
  );
  if (!status.data || visible.length === 0) return null;

  function dismiss(item: SetupChecklistItem) {
    dismissSetupItem(communityId, item.id);
    setDismissed((prev) => new Set([...prev, item.id]));
  }

  return (
    <Card className="mb-6">
      <SectionTitle>Setup</SectionTitle>
      <p className="text-sm text-zinc-400">
        Finish these so Discord, GitHub and call capture work end to end. Dismiss hides an item
        here only —{" "}
        <Link className="underline" href={routes.integrations(slug)}>Integrations</Link>
        {" "}still shows the real status.
      </p>
      <ul className="mt-3 space-y-2">
        {visible.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <Link className="text-indigo-400 hover:underline" href={hrefFor(slug, item.id)}>
              {item.label}
            </Link>
            <Button variant="ghost" onClick={() => dismiss(item)}>
              Dismiss
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
