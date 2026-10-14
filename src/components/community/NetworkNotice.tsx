"use client";

// Network markers for communities. Every community runs on one Cardano
// network chosen at creation. Testnet must never look like mainnet, and a
// wallet set to the other network cannot sign or be paid, so both facts are
// shown on every page of the community, not just on a badge.
import { asNetwork } from "@/lib/config";
import { networkMismatchReason } from "@/lib/networkGate";
import { useCommunity } from "@/hooks/useCommunity";
import { useSession } from "@/hooks/useSession";
import { Badge } from "@/components/ui";

/** "Preprod" marker for test communities and wallets; renders nothing on mainnet. */
export function NetworkBadge({ network }: { network: number }) {
  if (asNetwork(network) === 1) return null;
  return <Badge tone="yellow">Preprod</Badge>;
}

/**
 * Strip under the top bar on every page of a community: amber on preprod
 * ("test ADA only"), red when the connected wallet is on the other network.
 */
export function CommunityNetworkStrip({ slug }: { slug: string }) {
  const { community } = useCommunity(slug);
  const { walletNetwork } = useSession();
  if (!community) return null;
  const target = asNetwork(community.network);
  const reason = networkMismatchReason(walletNetwork, target);
  if (reason) {
    return (
      <div role="alert" className="network-strip network-strip-warn">
        {reason}
      </div>
    );
  }
  if (target === 0) {
    return (
      <div role="status" className="network-strip">
        <strong>Preprod testnet</strong> — test ADA only. Nothing in this
        community has real value; use it to try the platform.
      </div>
    );
  }
  return null;
}
