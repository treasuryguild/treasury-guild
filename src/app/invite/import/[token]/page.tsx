"use client";

import { use, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ImportInvitePreviewResponse, OkResponse } from "@/lib/api/types";
import { routes } from "@/lib/routes";
import { NetworkBadge } from "@/components/community/NetworkNotice";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useSession } from "@/hooks/useSession";
import { Button, Card, ErrorText, LinkButton, PageTitle } from "@/components/ui";

/**
 * A script signer connects the wallet whose payment key is in the imported
 * CBOR. Membership is not required for base signers; recovery and co-signer
 * slots still need an existing membership (enforced on claim).
 */
export default function ImportInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const { sessionWallet, loading: sessionLoading, signIn, signingIn } = useSession();
  const preview = useAsyncData(token || null, async () =>
    apiFetch<ImportInvitePreviewResponse>(`/api/treasury-import-invites/${encodeURIComponent(token)}`),
  );
  const send = useAsyncAction("Could not claim your signer key");
  const [saved, setSaved] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    setSaved(false);
    setLocalError(null);
    attempted.current = false;
  }, [token, sessionWallet]);

  async function claim() {
    setLocalError(null);
    if (!sessionWallet) {
      setLocalError("Sign in with the wallet that is a signer of this treasury.");
      return;
    }
    const result = await send.run(() =>
      apiFetch<OkResponse>(`/api/treasury-import-invites/${encodeURIComponent(token)}/claim`, {
        body: {},
      }),
    );
    if (!result) return;
    setSaved(true);
    preview.reload();
  }

  useEffect(() => {
    if (!sessionWallet || !preview.data?.valid || saved || attempted.current) return;
    attempted.current = true;
    void claim();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [sessionWallet, preview.data?.valid, saved]);

  if (preview.loading || sessionLoading) return null;

  if (preview.error || !preview.data) {
    return (
      <div className="mx-auto max-w-lg py-12">
        <PageTitle>Import signer invite</PageTitle>
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
        <PageTitle>Import signer invite</PageTitle>
        <Card>
          <p className="text-sm">
            The invite for <span className="font-medium">{info.treasuryName}</span> in{" "}
            <span className="font-medium">{info.communityName}</span> is no longer valid.
            It may have expired, or the treasury may already have been imported.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-12">
      <PageTitle>Import signer invite</PageTitle>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-medium">{info.treasuryName}</h2>
          <NetworkBadge network={info.network} />
        </div>
        <p className="mt-1 text-sm text-zinc-400">{info.communityName}</p>
        <p className="mt-3 text-sm text-zinc-400">
          Sign in with the wallet whose payment key is in this treasury&apos;s script.
          Treasury Guild checks that key against the invite and records your payment
          address. {info.filled} of {info.total} signers have claimed.
        </p>

        {saved ? (
          <p className="mt-4 text-sm text-emerald-400">
            Your signer key is claimed. You can close this page.
          </p>
        ) : sessionWallet ? (
          <div className="mt-4 space-y-3">
            <ErrorText error={send.error ?? localError} />
            <Button onClick={() => void claim()} loading={send.busy}>
              Claim with this wallet
            </Button>
          </div>
        ) : (
          <div className="mt-4">
            <Button onClick={() => void signIn()} loading={signingIn}>
              Sign in to claim
            </Button>
          </div>
        )}

        <div className="mt-4">
          <LinkButton href={routes.community(info.slug)} variant="secondary">
            Open {info.communityName}
          </LinkButton>
        </div>
      </Card>
    </div>
  );
}
