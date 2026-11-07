// IPFS URL helpers. Client-safe (gateway host is passed in; the server reads
// it from env, the browser gets it from /api/ipfs/gateway).

/** IPFS CIDv0 (Qm…, base58) or CIDv1 (b…, base32 lower-case). */
export const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

export function ipfsUrl(gateway: string, cid: string): string {
  return `https://${gateway}/ipfs/${cid}`;
}

/** "ipfs://<cid>" or "ipfs://ipfs/<cid>" -> gateway URL; http(s) passes through. */
export function ipfsToHttp(uri: string, gateway: string): string | null {
  if (uri.startsWith("ipfs://")) {
    const cid = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    return ipfsUrl(gateway, cid);
  }
  if (/^https?:\/\//.test(uri)) return uri;
  return null;
}
