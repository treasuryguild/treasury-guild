// Accept pool1… bech32 or a 56-char hex pool id for Mesh stake certificates.

const POOL_HEX_RE = /^[0-9a-f]{56}$/i;
const POOL_BECH32_RE = /^pool1[a-z0-9]+$/i;

/** Normalise a user-supplied pool id for Mesh (`delegateStakeCertificate`). */
export function normalizePoolId(poolId: string): string {
  const trimmed = poolId.trim();
  if (POOL_HEX_RE.test(trimmed) || POOL_BECH32_RE.test(trimmed)) return trimmed;
  throw new Error("Pool id must be pool1… or a 56-character hex id");
}
