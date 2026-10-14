// Pure rule for "can this wallet act here": a wallet set to one Cardano
// network cannot sign for, pay from or be paid by a treasury on the other.
// Client-safe; the hook `useNetworkGate` feeds it the live wallet network.

import { networkName, type Network } from "./config";

/**
 * Why the connected wallet cannot act on `target`, or null when it can (or
 * when no wallet network is known yet — nothing to block on).
 */
export function networkMismatchReason(
  walletNetwork: Network | null,
  target: Network,
): string | null {
  if (walletNetwork === null || walletNetwork === target) return null;
  return `Your wallet is on ${networkName(walletNetwork)}, but this community runs on ${networkName(target)}. Switch to a ${networkName(target)} account in your wallet to continue.`;
}

/** Discovery ordering: communities on the wallet's network first, stable otherwise. */
export function sortByWalletNetwork<T extends { network: number }>(
  communities: readonly T[],
  walletNetwork: Network | null,
): T[] {
  if (walletNetwork === null) return [...communities];
  return [...communities].sort(
    (a, b) => Number(b.network === walletNetwork) - Number(a.network === walletNetwork),
  );
}
