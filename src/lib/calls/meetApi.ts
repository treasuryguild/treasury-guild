// Google Meet REST (v2) as the Google account a community connected: the one
// that organises its meetings. Meet reports conference records only to the
// owner of the meeting space, hence one shared host account per community.
// Scope: meetings.space.readonly (who attended and when; no audio, video,
// chat, recordings or calendar).
import "server-only";

import { googleClientId, googleClientSecret } from "@/lib/env.server";
import { UpstreamError } from "@/lib/errors";
import { googleSubFromIdToken } from "@/lib/oauth/identityProviders";
import { connectionAccessToken, expiresAt, postTokenForm } from "@/lib/oauth/token";
import type { MeetConferenceRecord, MeetParticipant, MeetParticipantSession } from "./meetSessions";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://meet.googleapis.com/v2";
export const MEET_HOST_SCOPE = "openid https://www.googleapis.com/auth/meetings.space.readonly";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
  const { ok, status, body } = await postTokenForm<TokenResponse>(TOKEN_URL, {
    client_id: googleClientId(), client_secret: googleClientSecret(), ...fields,
  });
  if (!ok || !body.access_token) {
    throw new UpstreamError(`Google token request failed (${status}): ${body.error ?? "unknown"}`);
  }
  return body;
}

export interface GoogleHostGrant {
  /** The host account's id (OpenID `sub`). */
  accountId: string;
  tokens: { access_token: string; refresh_token: string; expires_at: string };
}

/** The host callback's code -> the account and its tokens. */
export async function exchangeGoogleHostCode(code: string, redirectUri: string): Promise<GoogleHostGrant> {
  const body = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  // Google issues a refresh token only with access_type=offline and a fresh consent.
  if (!body.refresh_token) throw new UpstreamError("Google returned no refresh token: remove the app's access in the Google account and connect again");
  if (!body.scope?.includes("meetings.space.readonly")) {
    throw new UpstreamError("The Meet permission was not granted: tick it on Google's consent screen");
  }
  if (!body.id_token) throw new UpstreamError("Google returned no ID token");
  return {
    accountId: googleSubFromIdToken(body.id_token, googleClientId()),
    tokens: {
      access_token: body.access_token as string,
      refresh_token: body.refresh_token,
      expires_at: expiresAt(body.expires_in),
    },
  };
}

/** A valid access token of the connection. Google keeps the refresh token; only the access token turns over. */
function accessTokenFor(integrationId: string): Promise<string> {
  return connectionAccessToken(integrationId, "Google", async (secrets) => {
    const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: secrets.refresh_token });
    return {
      access_token: fresh.access_token as string,
      refresh_token: fresh.refresh_token ?? secrets.refresh_token,
      expires_at: expiresAt(fresh.expires_in),
    };
  });
}

/** Best effort: tell Google to forget the grant when a community disconnects. */
export async function revokeGoogleToken(refreshToken: string): Promise<void> {
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
  }).catch(() => undefined);
}

/** A Meet client bound to one connection: one token lookup for a whole capture. */
export async function meetClient(integrationId: string) {
  const token = await accessTokenFor(integrationId);

  async function list<T>(path: string, field: string, params: Record<string, string>, maxPages: number): Promise<T[]> {
    const items: T[] = [];
    let pageToken = "";
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${API}/${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new UpstreamError(`Google Meet ${field} failed (${res.status}): ${body.error?.message ?? "unknown"}`);
      }
      const body = (await res.json()) as Record<string, unknown> & { nextPageToken?: string };
      items.push(...((body[field] as T[] | undefined) ?? []));
      pageToken = body.nextPageToken ?? "";
      if (!pageToken) break;
    }
    return items;
  }

  return {
    /** The code's conferences, newest first (a code is reused for every occurrence). */
    conferenceRecords: (meetingCode: string) =>
      list<MeetConferenceRecord>("conferenceRecords", "conferenceRecords",
        { filter: `space.meeting_code = "${meetingCode}"`, pageSize: "25" }, 1),
    participants: (record: string) =>
      list<MeetParticipant>(`${record}/participants`, "participants", { pageSize: "250" }, 4),
    participantSessions: (participant: string) =>
      list<MeetParticipantSession>(`${participant}/participantSessions`, "participantSessions", { pageSize: "250" }, 2),
  };
}
