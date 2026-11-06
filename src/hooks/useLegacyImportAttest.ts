"use client";

import { apiFetch } from "@/lib/api/client";
import type { LegacyAttestBody } from "@/lib/api/schemas";
import type { LegacyHistoryImportResponse } from "@/lib/api/types";
import { MSG } from "@/lib/constants";
import { legacyAttestationText, type LegacyAttestKind } from "@/lib/legacyHistory/attestation";
import { useAsyncAction } from "./useAsyncAction";
import { useSession } from "./useSession";

export function useLegacyImportAttest(args: {
  communityId: string;
  communitySlug: string;
  legacyWalletId: string;
  walletAddress: string;
  host: string;
}) {
  const { wallet, sessionWallet, connected, connecting, walletMismatch } = useSession();
  const action = useAsyncAction("Signature was not recorded");
  const blockedReason = !wallet
    ? connecting || connected ? "Connecting your wallet…" : MSG.walletNotConnected
    : walletMismatch ? MSG.walletSwitched : null;

  function attest(
    kind: LegacyAttestKind,
    importId: string,
    planHash: string,
  ): Promise<LegacyHistoryImportResponse | undefined> {
    return action.run(async () => {
      if (!wallet || !sessionWallet) throw new Error(MSG.walletNotConnected);
      const signedAt = new Date().toISOString();
      const text = legacyAttestationText({
        host: args.host,
        community: args.communitySlug,
        legacyWalletId: args.legacyWalletId,
        address: args.walletAddress,
        kind,
        planHash,
        signedAt,
      });
      const { key, signature } = await wallet.signData(text, sessionWallet);
      const body: LegacyAttestBody = {
        communityId: args.communityId,
        importId,
        kind,
        signedAt,
        key,
        signature,
        signerAddress: sessionWallet,
      };
      return apiFetch<LegacyHistoryImportResponse>("/api/legacy-history/attest", { body });
    });
  }

  return { attest, busy: action.busy, error: action.error, blockedReason };
}
