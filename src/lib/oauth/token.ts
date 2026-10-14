// OAuth token endpoint plumbing shared by every provider: the form POST, the
// expiry stamp and the refresh-before-use of a stored connection. What counts
// as a usable response differs per provider, so callers judge the body.
import "server-only";

import { loadIntegrationSecrets, saveIntegrationSecrets, type IntegrationSecrets } from "@/lib/db/callCapture";
import { UpstreamError } from "@/lib/errors";

/** Refresh this long before a stored access token expires. */
export const EXPIRY_MARGIN_MS = 60_000;

export interface TokenResponse<T> {
  ok: boolean;
  status: number;
  body: T;
}

/**
 * POST a form-encoded token request (authorization_code or refresh_token).
 * `basicAuth` sends the client credentials as HTTP Basic (Zoom) instead of in
 * the form. A body that is not JSON reads as `{}`.
 */
export async function postTokenForm<T extends object = Record<string, unknown>>(
  url: string,
  fields: Record<string, string>,
  options: { basicAuth?: { clientId: string; clientSecret: string } } = {},
): Promise<TokenResponse<Partial<T>>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (options.basicAuth) {
    const { clientId, clientSecret } = options.basicAuth;
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }
  const res = await fetch(url, { method: "POST", headers, body: new URLSearchParams(fields) });
  const body = (await res.json().catch(() => ({}))) as Partial<T>;
  return { ok: res.ok, status: res.status, body };
}

/** When a token issued now with this lifetime (seconds, default an hour) expires. */
export function expiresAt(expiresIn: number | undefined, now = Date.now()): string {
  return new Date(now + (expiresIn ?? 3600) * 1000).toISOString();
}

/**
 * A valid access token of a stored connection. When it is due, `refresh`
 * returns the new tokens, which are saved before use: Zoom rotates refresh
 * tokens, so the old one is dead the moment the new pair exists.
 */
export async function connectionAccessToken(
  integrationId: string,
  label: string,
  refresh: (current: IntegrationSecrets) => Promise<IntegrationSecrets>,
): Promise<string> {
  const secrets = await loadIntegrationSecrets(integrationId);
  if (!secrets) throw new UpstreamError(`The ${label} account is connected without tokens: connect it again`);
  if (Date.parse(secrets.expires_at) - Date.now() > EXPIRY_MARGIN_MS) return secrets.access_token;
  const fresh = await refresh(secrets);
  await saveIntegrationSecrets(integrationId, fresh);
  return fresh.access_token;
}
