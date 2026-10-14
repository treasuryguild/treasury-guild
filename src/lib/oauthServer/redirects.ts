// Redirect-URI and client-id rules of the authorization server. Pure: no
// database, no network.

/** Hard cap on how many redirect URIs one client may register. */
export const MAX_REDIRECT_URIS = 10;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** A redirect back to a program on the user's own machine (a CLI or desktop client). */
export function isLoopbackRedirect(value: string): boolean {
  try {
    return isLoopbackHttp(new URL(value));
  } catch {
    return false;
  }
}

/**
 * A Client ID Metadata Document client_id: an https URL with a path, on the
 * default port only (the document fetch is an SSRF sink; an explicit port
 * would let a client_id probe arbitrary services).
 */
export function isMetadataUrlClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && url.port === "" && url.pathname.length > 1;
  } catch {
    return false;
  }
}

/**
 * A redirect URI a browser may be sent to: https, or http on a loopback host
 * (RFC 8252, native clients such as Claude Code), never with a fragment.
 * Every registration path applies it, and the decision re-checks it before
 * the URL reaches `window.location`: a `javascript:` URI would run script on
 * this origin.
 */
export function isAcceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  return url.protocol === "https:" || isLoopbackHttp(url);
}

/**
 * Exact match, except the port of a loopback redirect: a native client binds
 * an ephemeral port at run time, so `http://127.0.0.1:51763/callback` matches
 * a registered `http://127.0.0.1/callback`. Only the port is ignored, only for
 * literal loopback hosts.
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let reg: URL;
  let req: URL;
  try {
    reg = new URL(registered);
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(reg) || !isLoopbackHttp(req)) return false;
  return reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
}

/** The requested URI when one of the client's registered URIs matches it, else null. */
export function findMatchingRedirectUri(registered: readonly string[], requested: string): string | null {
  return registered.some((uri) => redirectUriMatches(uri, requested)) ? requested : null;
}
