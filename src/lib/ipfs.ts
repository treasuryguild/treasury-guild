// IPFS URL helpers. Client-safe (gateway host is passed in; the server reads
// it from env, the browser gets it from /api/ipfs/gateway).

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
