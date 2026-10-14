"use client";

import { useSessionGate } from "@/hooks/useCommunityGate";
import { useMyIdentities } from "@/hooks/useMyIdentities";
import { IdentityProvider } from "@/lib/constants";
import { shortAddress } from "@/lib/format";
import { routes } from "@/lib/routes";
import { Card, PageTitle } from "@/components/ui";
import { GithubLinkCard } from "@/components/profile/GithubLinkCard";
import { HandleCard } from "@/components/profile/HandleCard";
import { IdentityLinkCard } from "@/components/profile/IdentityLinkCard";
import { AiConnectionsCard } from "@/components/settings/AiConnectionsCard";

// Wallet-scoped profile: display handle and the one-off account links. GitHub
// lets issue assignees be paid to the right wallet (non-GitHub users still show
// up by name in assignee dropdowns); Discord and Google let call capture
// recognise the wallet's owner. AI assistants approved on the consent page are
// listed last, each with a Disconnect.

export default function SettingsPage() {
  const { sessionWallet, blocked } = useSessionGate();
  const identities = useMyIdentities();
  if (blocked) return blocked;

  return (
    <div className="max-w-xl space-y-4">
      <PageTitle>Settings</PageTitle>

      <Card>
        <h3 className="font-medium">Wallet</h3>
        <p className="mt-2 font-mono text-sm text-zinc-400">
          {shortAddress(sessionWallet!)}
        </p>
      </Card>

      <HandleCard />

      <GithubLinkCard returnTo={routes.settings()} />

      {Object.values(IdentityProvider).map((provider) => (
        <IdentityLinkCard key={provider} provider={provider} returnTo={routes.settings()}
          identity={identities.data?.find((i) => i.provider === provider) ?? null}
          onChanged={identities.reload} />
      ))}

      <AiConnectionsCard wallet={sessionWallet!} />
    </div>
  );
}
