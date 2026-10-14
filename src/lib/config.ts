// Client-safe configuration. Server secrets live in env.server.ts.

export type Network = 0 | 1;

/** 0 = preprod, 1 = mainnet. */
export function appNetwork(): Network {
  return process.env.NEXT_PUBLIC_NETWORK === "1" ? 1 : 0;
}

export function networkName(network: Network): "preprod" | "mainnet" {
  return network === 1 ? "mainnet" : "preprod";
}

/** Narrow a DB integer to Network (anything but 1 is preprod). */
export function asNetwork(n: number): Network {
  return n === 1 ? 1 : 0;
}

export function explorerTxUrl(network: Network, txHash: string): string {
  return network === 1
    ? `https://cexplorer.io/tx/${txHash}`
    : `https://preprod.cexplorer.io/tx/${txHash}`;
}

/** Wallet page: pool.pm on mainnet (no preprod support there), cexplorer on preprod. */
export function explorerAddressUrl(network: Network, address: string): string {
  return network === 1
    ? `https://pool.pm/${address}`
    : `https://preprod.cexplorer.io/address/${address}`;
}
