"use client";

import { useState, type ReactNode } from "react";
import { apiFetch, apiUrl } from "@/lib/api/client";
import type { CallIntegrationRow } from "@/lib/db/types";
import { formatDate } from "@/lib/format";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCallIntegration } from "@/hooks/useCalls";
import { useOAuthOutcome } from "@/hooks/useOAuthOutcome";
import { Button, Card, ConfirmDialog, ErrorText, LinkButton, OAuthOutcomeBanner } from "@/components/ui";

/**
 * One host connection (Discord server, Zoom or Google Meet). Connecting is a
 * full redirect through the platform's consent screen that ends back here as
 * ?<outcomeParam>=<outcome>; disconnecting is a DELETE on the same API path.
 */
export function IntegrationCard({
  communityId,
  provider,
  title,
  blurb,
  footnote,
  apiPath,
  outcomeParam,
  returnTo,
  nouns,
  disconnectWarning,
}: {
  communityId: string;
  provider: CallIntegrationRow["provider"];
  title: string;
  blurb: ReactNode;
  footnote: ReactNode;
  /** GET starts the connect flow (?communityId&returnTo), DELETE disconnects. */
  apiPath: string;
  outcomeParam: string;
  returnTo: string;
  /** What is connected, for the copy: "server", "account". */
  nouns: { thing: string; connect: string; change: string };
  disconnectWarning: ReactNode;
}) {
  const connection = useCallIntegration(communityId, provider);
  const disconnect = useAsyncAction(`Could not disconnect the ${nouns.thing}`);
  const [confirming, setConfirming] = useState(false);
  const outcome = useOAuthOutcome(outcomeParam);
  // The title without its leading emoji: "Discord server connected."
  const name = title.replace(/^\S+\s/, "");
  const connectHref = apiUrl(apiPath, { communityId, returnTo });

  async function disconnectNow() {
    const ok = await disconnect.run(() => apiFetch(apiPath, { method: "DELETE", body: { communityId } }));
    if (ok) {
      setConfirming(false);
      outcome.clear();
      connection.reload();
    }
  }

  return (
    <Card>
      <h3 className="font-medium">{title}</h3>
      <p className="mt-1 text-sm text-zinc-400">{blurb}</p>
      <OAuthOutcomeBanner name={name} outcome={outcome.outcome} reason={outcome.reason} messages={{
        cancelled: "Connection cancelled.",
        error: "Connection failed. Please try again.",
      }} />
      <ErrorText error={connection.error} className="mt-3" />
      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-3">
        {connection.data ? (
          <>
            <span className="min-w-0 break-all text-sm">
              {connection.data.label ?? `Connected ${nouns.thing}`}{" "}
              <span className="text-xs text-zinc-500">since {formatDate(connection.data.created_at)}</span>
            </span>
            <LinkButton external variant="secondary" href={connectHref}>{nouns.change}</LinkButton>
            <Button variant="ghost" onClick={() => setConfirming(true)}>Disconnect</Button>
          </>
        ) : (
          !connection.loading && <LinkButton external href={connectHref}>{nouns.connect}</LinkButton>
        )}
      </div>
      <p className="mt-4 text-xs text-zinc-500">{footnote}</p>

      <ConfirmDialog open={confirming} busy={disconnect.busy} error={disconnect.error}
        title={`Disconnect the ${nouns.thing}?`} confirmLabel="Disconnect"
        onCancel={() => setConfirming(false)} onConfirm={() => void disconnectNow()}>
        {disconnectWarning}
      </ConfirmDialog>
    </Card>
  );
}
