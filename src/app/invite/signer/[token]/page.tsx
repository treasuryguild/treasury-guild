"use client";

import { use, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { OkResponse, SignerInvitePreviewResponse } from "@/lib/api/types";
import { readConnectedSignerKeys } from "@/lib/cardano/connectedSignerKeys";
import { routes } from "@/lib/routes";
import { NetworkBadge } from "@/components/community/NetworkNotice";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useSession } from "@/hooks/useSession";
import { Button, Card, ErrorText, LinkButton, PageTitle } from "@/components/ui";

/**
 * A listed base signer connects the wallet the admin named. Stake and DRep
 * keys are read from that wallet (CIP-30), the same way Mesh Multisig does,
 * and stored on the draft. Membership is not required.
 */
export default function SignerInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const { sessionWallet, wallet: meshWallet, loading: sessionLoading, signIn, signingIn } = useSession();
  const preview = useAsyncData(token || null, async () =>
    apiFetch<SignerInvitePreviewResponse>(`/api/treasury-signer-invites/${encodeURIComponent(token)}`),
  );
  const send = useAsyncAction("Could not save your stake address");
  const [saved, setSaved] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    setSaved(false);
    setLocalError(null);
    attempted.current = false;
  }, [token, sessionWallet]);

  async function contribute() {
    setLocalError(null);
    if (!meshWallet) {
      setLocalError("Reconnect the wallet you signed in with so its stake address can be read.");
      return;
    }
    const keys = await readConnectedSignerKeys(meshWallet);
    if (!keys.stakeAddress) {
      setLocalError("This wallet did not provide a stake address, so it cannot complete an SDK signer slot.");
      return;
    }
    const result = await send.run(() =>
      apiFetch<OkResponse>(`/api/treasury-signer-invites/${encodeURIComponent(token)}/contribute`, {
        body: {
          stakeAddress: keys.stakeAddress,
          ...(keys.drepKeyHash ? { drepKeyHash: keys.drepKeyHash } : {}),
        },
      }),
    );
    if (!result) return;
    setSaved(true);
    preview.reload();
  }

  // One automatic attempt once the signed-in wallet can be read.
  useEffect(() => {
    if (!sessionWallet || !meshWallet || !preview.data?.valid || saved || attempted.current) return;
    attempted.current = true;
    void contribute();
    // contribute closes over the latest wallet; the ref stops a second auto-send.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [sessionWallet, meshWallet, preview.data?.valid, saved]);

  if (preview.loading || sessionLoading) return null;

  if (preview.error || !preview.data) {
    return (
      <div className="mx-auto max-w-lg py-12">
        <PageTitle>Treasury signer invite</PageTitle>
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
        <PageTitle>Treasury signer invite</PageTitle>
        <Card>
          <p className="text-sm">
            The invite for <span className="font-medium">{info.treasuryName}</span> in{" "}
            <span className="font-medium">{info.communityName}</span> is no longer valid.
            It may have expired, or the treasury may already have been created.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-12">
      <PageTitle>Treasury signer invite</PageTitle>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-medium">{info.treasuryName}</h2>
          <NetworkBadge network={info.network} />
        </div>
        <p className="mt-1 text-sm text-zinc-400">{info.communityName}</p>
        <p className="mt-3 text-sm text-zinc-400">
          Sign in with the wallet that was listed as a base signer. Treasury Guild
          reads that wallet&apos;s stake address and, when the wallet provides one,
          its DRep key hash. {info.filled} of {info.total} signers have connected.
        </p>

        {saved && (
          <p className="mt-4 text-sm">
            Your stake address is saved. The admin can create the treasury once every
            signer has connected. A missing DRep key is allowed: the payment script
            is then used as the DRep.
          </p>
        )}

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
          <div className="mt-4 space-y-3">
            {localError && <p className="text-sm text-red-400">{localError}</p>}
            <ErrorText error={saved ? null : send.error} />
            {send.error === "This wallet is not a listed signer" && (
              <p className="text-sm text-zinc-400">
                The wallet you signed in with is not one of the signers on this invite.
              </p>
            )}
            <Button loading={send.busy} onClick={() => void contribute()}>
              {send.busy ? "Reading wallet…" : "Send stake and DRep keys"}
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
