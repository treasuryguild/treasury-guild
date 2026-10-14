"use client";

// One-off Discord / Google account link on the Profile page, so a community's
// call capture can recognise this wallet's owner. Same round trip as the
// GitHub link: a full redirect that comes back as ?<provider>=<outcome>.

import { apiFetch, apiUrl } from "@/lib/api/client";
import { IdentityProvider } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import type { MyIdentity } from "@/hooks/useMyIdentities";
import { useOAuthOutcome } from "@/hooks/useOAuthOutcome";
import { Button, Card, ErrorText, LinkButton, OAuthOutcomeBanner } from "@/components/ui";

const COPY: Record<IdentityProvider, { title: string; name: string; blurb: string }> = {
  [IdentityProvider.Discord]: {
    title: "🎧 Discord account",
    name: "Discord",
    blurb:
      "Link your Discord account and communities can recognise you in their voice calls, so call rewards reach this wallet. Guild Vault learns your Discord user id and name, nothing else.",
  },
  [IdentityProvider.Google]: {
    title: "📹 Google account",
    name: "Google",
    blurb:
      "Link the Google account you join Meet calls with, so call rewards reach this wallet. Guild Vault learns only the account's id: no email, name or other data.",
  },
};


export function IdentityLinkCard({
  provider,
  identity,
  returnTo,
  onChanged,
}: {
  provider: IdentityProvider;
  /** The wallet's linked account of this provider, if any. */
  identity: MyIdentity | null;
  returnTo: string;
  onChanged: () => void;
}) {
  const copy = COPY[provider];
  const outcome = useOAuthOutcome(provider);
  const disconnect = useAsyncAction(`Could not disconnect ${copy.name}`);

  async function unlink() {
    const ok = await disconnect.run(() => apiFetch(`/api/${provider}/connect`, { method: "DELETE" }));
    if (ok) {
      outcome.clear();
      onChanged();
    }
  }

  return (
    <Card>
      <h3 className="font-medium">{copy.title}</h3>
      <p className="mt-1 text-sm text-zinc-400">{copy.blurb}</p>
      <OAuthOutcomeBanner name={copy.name} outcome={outcome.outcome} reason={outcome.reason}
        messages={{ connected: `${copy.name} account connected.` }} />
      <ErrorText error={disconnect.error} className="mt-3" />
      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-3">
        {identity ? (
          <>
            <span className="min-w-0 break-all text-sm">
              {identity.display_name ?? "Linked"}{" "}
              <span className="text-xs text-zinc-500">since {formatDate(identity.verified_at)}</span>
            </span>
            <Button variant="secondary" disabled={disconnect.busy} onClick={() => void unlink()}>
              Disconnect
            </Button>
          </>
        ) : (
          <LinkButton external href={apiUrl(`/api/${provider}/connect`, { returnTo })}>
            Connect {copy.name}
          </LinkButton>
        )}
      </div>
    </Card>
  );
}
