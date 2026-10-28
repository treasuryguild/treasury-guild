"use client";

import { use, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { InvitePreviewResponse, RedeemInviteResponse } from "@/lib/api/types";
import { NetworkBadge } from "@/components/community/NetworkNotice";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useSession } from "@/hooks/useSession";
import { routes } from "@/lib/routes";
import {
  Button,
  Card,
  ErrorText,
  LinkButton,
  PageTitle,
} from "@/components/ui";

/**
 * Shared invite link landing page. Open without being a member: sign in with
 * a wallet, join as a member, then optionally finish Profile (handle and
 * linked accounts). Private communities stay off Discover.
 */
export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const { sessionWallet, loading: sessionLoading, signIn, signingIn } = useSession();
  const preview = useAsyncData(token || null, async () =>
    apiFetch<InvitePreviewResponse>(`/api/invites/${encodeURIComponent(token)}`),
  );
  const redeem = useAsyncAction();
  const [joined, setJoined] = useState<RedeemInviteResponse | null>(null);

  // A signed-in member who reopens their own invite still sees the nudge once.
  useEffect(() => {
    setJoined(null);
  }, [token, sessionWallet]);

  async function join() {
    const result = await redeem.run(() =>
      apiFetch<RedeemInviteResponse>(`/api/invites/${encodeURIComponent(token)}/redeem`, {
        method: "POST",
      }),
    );
    if (result) setJoined(result);
  }

  if (preview.loading || sessionLoading) return null;

  if (preview.error || !preview.data) {
    return (
      <div className="mx-auto max-w-lg py-12">
        <PageTitle>Join community</PageTitle>
        <Card>
          <p className="text-sm text-zinc-400">
            This invite link is not valid. Ask a community admin for a new one.
          </p>
        </Card>
      </div>
    );
  }

  const info = preview.data;

  if (!info.valid) {
    return (
      <div className="mx-auto max-w-lg py-12">
        <PageTitle>Join community</PageTitle>
        <Card>
          <p className="text-sm">
            The invite to <span className="font-medium">{info.name}</span> is no
            longer valid (it may have expired, been revoked, or reached its use
            limit).
          </p>
          <p className="mt-2 text-sm text-zinc-400">
            Ask a community admin for a fresh link.
          </p>
        </Card>
      </div>
    );
  }

  if (joined) {
    return (
      <div className="mx-auto max-w-lg py-12">
        <PageTitle>Welcome</PageTitle>
        <Card>
          <p className="text-sm">
            {joined.already ? "You are already a member of" : "You joined"}{" "}
            <span className="font-medium">{joined.name}</span>.
          </p>
          <p className="mt-3 text-sm text-zinc-400">
            Optional next steps on your profile: choose a display handle, and
            link Discord, GitHub or Google if you use them for calls or GitHub
            boards.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <LinkButton href={routes.community(joined.slug)}>
              Open {joined.name}
            </LinkButton>
            <LinkButton href={routes.settings()} variant="secondary">
              Profile &amp; settings
            </LinkButton>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-12">
      <PageTitle>Join community</PageTitle>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-medium">{info.name}</h2>
          <NetworkBadge network={info.network} />
        </div>
        <p className="mt-2 text-sm text-zinc-400">
          Sign in with your Cardano wallet to join as a member. You can set a
          display handle and link Discord, GitHub or Google afterwards.
        </p>
        {!sessionWallet ? (
          <div className="mt-4">
            <p className="mb-3 text-sm text-zinc-500">
              Connect a wallet in the top bar, then sign in.
            </p>
            <Button loading={signingIn} onClick={() => void signIn()}>
              {signingIn ? "Signing in…" : "Sign in with wallet"}
            </Button>
          </div>
        ) : (
          <div className="mt-4">
            <ErrorText error={redeem.error} className="mb-3" />
            <Button loading={redeem.busy} onClick={() => void join()}>
              {redeem.busy ? "Joining…" : `Join ${info.name}`}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
