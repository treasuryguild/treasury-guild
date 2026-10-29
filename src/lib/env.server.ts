// Server-only environment access. Every non-NEXT_PUBLIC variable is read
// here and nowhere else; getters are lazy so tests can set values at runtime.
import "server-only";

import type { Network } from "./config";
import { ConfigError } from "./errors";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(`${name} is not configured`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

// --- Supabase ---------------------------------------------------------------

export const supabaseUrl = () => requireEnv("NEXT_PUBLIC_SUPABASE_URL");
export const supabaseAnonKey = () => requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
export const supabaseServiceRoleKey = () =>
  requireEnv("SUPABASE_SERVICE_ROLE_KEY");
/** Legacy JWT secret: session JWTs are minted with it so RLS reads `wallet`. */
export const supabaseJwtSecret = () => requireEnv("SUPABASE_JWT_SECRET");

// --- App / cron -------------------------------------------------------------

export const appUrl = () => optionalEnv("APP_URL") ?? "http://localhost:3000";
/** Shared secret for the cron triggers. */
export const cronSecret = () => requireEnv("CRON_SECRET");
/**
 * Key for the HMAC-signed OAuth / install `state` (src/lib/oauth/state.ts).
 * Required in production (a key derived from CRON_SECRET would let a leaked
 * cron secret forge consent handles). Outside production an unset value
 * falls back to that derived key in state.ts.
 */
export function oauthStateSecret(): string | undefined {
  return isProduction() ? requireEnv("OAUTH_STATE_SECRET") : optionalEnv("OAUTH_STATE_SECRET");
}
/**
 * Key for the agent API's OAuth access tokens (src/lib/oauthServer). Never
 * the Supabase JWT secret, so an access token is never a database session and
 * a session JWT never an access token. Required in production: a key
 * derived from CRON_SECRET (which the cron triggers also hold) would let a
 * leaked cron secret mint read access for any wallet that connected a public
 * client. Outside production an unset value falls back to that derived key.
 */
export function mcpTokenSecret(): string | undefined {
  return isProduction() ? requireEnv("MCP_TOKEN_SECRET") : optionalEnv("MCP_TOKEN_SECRET");
}
/**
 * Encrypts the app-held co-signer keys (src/lib/cosigner/keys.ts), one per
 * co-signer treasury. Required in production: a key derived from CRON_SECRET
 * would let a leaked cron secret decrypt every co-signer key. Outside
 * production an unset value falls back to that derived key. Losing it makes
 * every app-held co-signer key unusable (the bypass path still moves funds).
 */
export function cosignerKeySecret(): string | undefined {
  return isProduction() ? requireEnv("COSIGNER_KEY_SECRET") : optionalEnv("COSIGNER_KEY_SECRET");
}

/**
 * Wallets allowed on the /dev tools page and its /api/dev/* routes:
 * comma-separated payment addresses. Empty = nobody.
 */
export function devWallets(): string[] {
  return (optionalEnv("DEV_WALLETS") ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

// --- Koios ------------------------------------------------------------------

export const koiosApiKey = () => optionalEnv("KOIOS_API_KEY");

/**
 * Koios REST host per network. Communities pick their own network, so an
 * override must be per network too (a single override would send preprod
 * traffic to a mainnet mirror or vice versa).
 */
export function koiosBaseUrl(network: Network): string {
  return network === 1
    ? (optionalEnv("KOIOS_BASE_URL_MAINNET") ?? "https://api.koios.rest/api/v1")
    : (optionalEnv("KOIOS_BASE_URL_PREPROD") ?? "https://preprod.koios.rest/api/v1");
}

// --- GitHub App -------------------------------------------------------------

export const githubAppId = () => requireEnv("GITHUB_APP_ID");
export const githubAppPrivateKey = () =>
  requireEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
export const githubAppSlug = () => requireEnv("GITHUB_APP_SLUG");
export const githubClientId = () => requireEnv("GITHUB_CLIENT_ID");
export const githubClientSecret = () => requireEnv("GITHUB_CLIENT_SECRET");
export const githubWebhookSecret = () => requireEnv("GITHUB_WEBHOOK_SECRET");

// --- Discord / Google (account linking) -------------------------------------

/** OAuth2 credentials of the Discord application (scope `identify`). */
export const discordClientId = () => requireEnv("DISCORD_CLIENT_ID");
export const discordClientSecret = () => requireEnv("DISCORD_CLIENT_SECRET");
/** Bot token of the same application: reads voice channels for call capture. */
export const discordBotToken = () => requireEnv("DISCORD_BOT_TOKEN");
/** Zoom OAuth app: the shared host account a community connects for call capture. */
export const zoomClientId = () => requireEnv("ZOOM_CLIENT_ID");
export const zoomClientSecret = () => requireEnv("ZOOM_CLIENT_SECRET");
/** The app's webhook "Secret Token": signs every event Zoom sends. */
export const zoomWebhookSecret = () => requireEnv("ZOOM_WEBHOOK_SECRET_TOKEN");
/** Google OAuth web client (scope `openid`). */
export const googleClientId = () => requireEnv("GOOGLE_CLIENT_ID");
export const googleClientSecret = () => requireEnv("GOOGLE_CLIENT_SECRET");

// --- Pinata / IPFS ----------------------------------------------------------

/** Pinata API JWT — never exposed to the browser. */
export const pinataJwt = () => requireEnv("PINATA_JWT");
/** Gateway host used to preview IPFS content, e.g. "x.mypinata.cloud". */
export const pinataGateway = () =>
  optionalEnv("PINATA_GATEWAY") ?? "gateway.pinata.cloud";
