"use client";

// Vote on a proposal: ask the server for the ballot text of a choice, sign
// it with the connected wallet (CIP-30 signData, 1.9 argument order through
// the session's bridged wallet) and send the signature back. The wallet must
// be the one the session signed in with, or the server refuses the ballot.
import { apiFetch } from "@/lib/api/client";
import type { BallotTextResponse, CastVoteResponse } from "@/lib/api/types";
import { MSG, type VoteChoice } from "@/lib/constants";
import { useAsyncAction } from "./useAsyncAction";
import { useSession } from "./useSession";

export function useBallot(proposalId: string) {
  const { wallet, sessionWallet, connected, connecting, walletMismatch } = useSession();
  const action = useAsyncAction("Your vote was not recorded");
  const blockedReason = !wallet
    ? connecting || connected ? "Connecting your wallet…" : MSG.walletNotConnected
    : walletMismatch ? MSG.walletSwitched : null;

  function vote(choice: VoteChoice, reason: string): Promise<CastVoteResponse | undefined> {
    return action.run(async () => {
      if (!wallet || !sessionWallet) throw new Error(MSG.walletNotConnected);
      const body = { choice, reason: reason.trim() || undefined };
      const { text, signedAt } = await apiFetch<BallotTextResponse>(`/api/proposals/${proposalId}/ballot`, { body });
      // 1.9 IWallet signature: signData(payload, address)
      const { key, signature } = await wallet.signData(text, sessionWallet);
      return apiFetch<CastVoteResponse>(`/api/proposals/${proposalId}/vote`, {
        body: { ...body, signedAt, key, signature },
      });
    });
  }

  return { vote, busy: action.busy, error: action.error, blockedReason };
}
