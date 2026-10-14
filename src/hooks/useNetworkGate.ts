"use client";

// The connected wallet's network against a community's, for pages that
// sign, build or pay: `reason` is set (and actions should be disabled) when
// the two differ. Null community network (still loading) never blocks.
import { asNetwork, type Network } from "@/lib/config";
import { networkMismatchReason } from "@/lib/networkGate";
import { useSession } from "./useSession";

export function useNetworkGate(communityNetwork: number | null | undefined): {
  walletNetwork: Network | null;
  reason: string | null;
} {
  const { walletNetwork } = useSession();
  const reason =
    communityNetwork === null || communityNetwork === undefined
      ? null
      : networkMismatchReason(walletNetwork, asNetwork(communityNetwork));
  return { walletNetwork, reason };
}
