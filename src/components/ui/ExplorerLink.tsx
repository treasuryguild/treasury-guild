import type { ReactNode } from "react";
import { explorerAddressUrl, explorerTxUrl, type Network } from "@/lib/config";

/** A transaction or address on the network's explorer, in a new tab. */
export function ExplorerLink({ network, target, children, className = "text-indigo-400 hover:underline", title }: {
  network: Network;
  target: { txHash: string } | { address: string };
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const href = "txHash" in target ? explorerTxUrl(network, target.txHash) : explorerAddressUrl(network, target.address);
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className} title={title}>
      {children}
    </a>
  );
}
