// What each host connection asks for and how its callback saves it. The
// generic flow (admin checks, state, redirects) is hostLink.ts.
import "server-only";

import { exchangeGoogleHostCode, MEET_HOST_SCOPE, revokeGoogleToken } from "@/lib/calls/meetApi";
import { exchangeZoomCode, fetchZoomAccount } from "@/lib/calls/zoomApi";
import { IntegrationProvider } from "@/lib/constants";
import { accountConnectedElsewhere, loadIntegration, loadIntegrationSecrets, saveIntegration } from "@/lib/db/callCapture";
import { leaveGuild } from "@/lib/discord/bot";
import {
  discordClientId, discordClientSecret, googleClientId, zoomClientId,
} from "@/lib/env.server";
import { errorMessage } from "@/lib/errors";
import type { HostLinkAdapter } from "./hostLink";
import { postTokenForm } from "./token";

/**
 * VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | READ_MESSAGE_HISTORY |
 * CREATE_PUBLIC_THREADS | SEND_MESSAGES_IN_THREADS — voice capture needs
 * view; governance posts need send/embed/threads. Channel overwrites can
 * still keep the bot quiet outside the chosen governance channel.
 */
const DISCORD_BOT_PERMISSIONS = "309237776896";

/**
 * The Discord server under Integrations: voice capture for calls, and (when a
 * channel is chosen) proposal announcements and discussion threads. The admin
 * adds the bot to a server they manage. The server id is taken from Discord's
 * token response and never from the query string: whoever finishes this flow
 * proved to Discord that they manage that server.
 */
export const discordGuildLink: HostLinkAdapter = {
  provider: IntegrationProvider.Discord,
  purpose: "discord-guild",
  queryKey: "discord_server",
  callbackPath: "/api/discord/guild-callback",
  authorizeUrl() {
    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("client_id", discordClientId());
    // A scope besides `bot` makes this a code grant: the token response then
    // names the server the bot was added to, which is the only server id trusted.
    url.searchParams.set("scope", "bot identify");
    url.searchParams.set("permissions", DISCORD_BOT_PERMISSIONS);
    url.searchParams.set("response_type", "code");
    return url;
  },
  async connect(code, redirectUri, owner) {
    const { ok, status, body } = await exchangeGuildCode(code, redirectUri);
    if (!ok) {
      console.error("discord guild token exchange failed:", status, body.error);
      return body.error ?? "token_exchange";
    }
    if (!body.guild?.id) return "no_server";
    const guildId = body.guild.id;
    const previous = await loadIntegration(owner.communityId, IntegrationProvider.Discord);
    try {
      await saveIntegration({
        community_id: owner.communityId,
        provider: IntegrationProvider.Discord,
        external_account_id: guildId,
        label: body.guild.name ?? null,
        created_by: owner.wallet,
      }, null);
    } catch (err) {
      // Discord added the bot during consent: take it out of a server no community uses.
      await leaveUnusedGuild(guildId);
      throw err;
    }
    // Re-pointed to another server: the bot leaves the old one unless another community uses it.
    if (previous && previous.external_account_id !== guildId) await leaveUnusedGuild(previous.external_account_id);
    return null;
  },
  // The bot leaves the server unless another community still uses it.
  async afterDelete(integration) {
    if (!(await accountConnectedElsewhere(IntegrationProvider.Discord, integration.external_account_id))) {
      await leaveGuild(integration.external_account_id);
    }
  },
  // Discord adds the bot at consent, before the callback is checked, and only
  // the token response names the server. On a refused callback the code is
  // still exchanged for that alone: it proves Discord added the bot to that
  // server through this app's consent, nothing is saved, and the one action
  // taken is leaving a server no community is connected to.
  async abandon(code, redirectUri) {
    const { ok, body } = await exchangeGuildCode(code, redirectUri);
    if (ok && body.guild?.id) await leaveUnusedGuild(body.guild.id);
  },
};

/** The bot grant's code -> Discord's token response, which names the server the bot was added to. */
function exchangeGuildCode(code: string, redirectUri: string) {
  return postTokenForm<{ error: string; guild: { id?: string; name?: string } }>(
    "https://discord.com/api/oauth2/token",
    {
      grant_type: "authorization_code",
      client_id: discordClientId(),
      client_secret: discordClientSecret(),
      code,
      redirect_uri: redirectUri,
    },
  );
}

/**
 * The Zoom account that hosts the community's calls. Attendance only reaches
 * Treasury Guild for meetings this account hosts, which is why a community uses
 * one shared host account.
 */
export const zoomHostLink: HostLinkAdapter = {
  provider: IntegrationProvider.Zoom,
  purpose: "zoom-host",
  queryKey: "zoom",
  callbackPath: "/api/zoom/oauth-callback",
  authorizeUrl() {
    const url = new URL("https://zoom.us/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", zoomClientId());
    return url;
  },
  async connect(code, redirectUri, owner) {
    const tokens = await exchangeZoomCode(code, redirectUri);
    const account = await fetchZoomAccount(tokens.access_token);
    await saveIntegration({
      community_id: owner.communityId,
      provider: IntegrationProvider.Zoom,
      external_account_id: account.accountId,
      label: account.displayName,
      created_by: owner.wallet,
    }, tokens);
    return null;
  },
};

/**
 * The Google account that organises the community's Meet calls. A different
 * grant from the personal account link (/api/google/connect, scope `openid`):
 * the host also grants meetings.space.readonly, offline, so attendance can be
 * read after a call. Disconnecting revokes the grant at Google.
 */
export const googleHostLink: HostLinkAdapter = {
  provider: IntegrationProvider.Google,
  purpose: "google-host",
  queryKey: "google_host",
  callbackPath: "/api/google/host-callback",
  authorizeUrl() {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", googleClientId());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", MEET_HOST_SCOPE);
    // A refresh token comes only with offline access and a fresh consent.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent select_account");
    return url;
  },
  async connect(code, redirectUri, owner) {
    const grant = await exchangeGoogleHostCode(code, redirectUri);
    // Re-pointed to another Google account: the old grant is revoked once the
    // new one is saved. Never for the same account, whose grant is the new one.
    const previous = await loadIntegration(owner.communityId, IntegrationProvider.Google);
    const replaced = previous && previous.external_account_id !== grant.accountId
      ? await loadIntegrationSecrets(previous.id)
      : null;
    await saveIntegration({
      community_id: owner.communityId,
      provider: IntegrationProvider.Google,
      external_account_id: grant.accountId,
      // Only `openid` identifies the account: there is no name or email to show.
      label: "Google account",
      created_by: owner.wallet,
    }, grant.tokens);
    if (previous && replaced) await revokeUnusedGoogleGrant(previous.external_account_id, replaced.refresh_token);
    return null;
  },
  // The two user-fixable cases carry their explanation to the page.
  failureReason(err) {
    const message = errorMessage(err, "");
    return message.includes("Meet permission") ? "meet_permission_not_granted"
      : message.includes("no refresh token") ? "no_refresh_token"
      : "exception";
  },
  // Revoking a refresh token ends the account's whole grant to the app, so
  // not while another community still uses that account.
  async afterDelete(integration, secrets) {
    if (secrets && !(await accountConnectedElsewhere(IntegrationProvider.Google, integration.external_account_id))) {
      await revokeGoogleToken(secrets.refresh_token);
    }
  },
};

/** Best effort: the bot leaves a server no community is connected to any more. */
async function leaveUnusedGuild(guildId: string): Promise<void> {
  try {
    if (!(await accountConnectedElsewhere(IntegrationProvider.Discord, guildId))) await leaveGuild(guildId);
  } catch (err) {
    console.error(`leaving Discord server ${guildId} failed`, err);
  }
}

/** Best effort: revoke a replaced Google account's grant unless another community uses that account. */
async function revokeUnusedGoogleGrant(accountId: string, refreshToken: string): Promise<void> {
  try {
    if (!(await accountConnectedElsewhere(IntegrationProvider.Google, accountId))) await revokeGoogleToken(refreshToken);
  } catch (err) {
    console.error("revoking the replaced Google grant failed", err);
  }
}
