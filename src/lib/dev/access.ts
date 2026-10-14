// Who may use the internal developer tools (/dev and /api/dev/*): a fixed
// allowlist of wallets from the DEV_WALLETS env var. Pure and client-safe;
// the server reads the list through env.server.ts (`devWallets`).

/** Exact match — bech32 addresses are case-sensitive. */
export function isDevWallet(
  wallet: string | null | undefined,
  allow: readonly string[],
): boolean {
  return !!wallet && allow.includes(wallet);
}
