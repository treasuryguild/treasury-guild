// Zoom REST as the host account a community connected. Access tokens last an
// hour and refresh tokens ROTATE: every refresh returns a new refresh token
// and kills the old one, so the new pair is saved before it is used.
import "server-only";

import { zoomClientId, zoomClientSecret } from "@/lib/env.server";
import { UpstreamError } from "@/lib/errors";
import { connectionAccessToken, expiresAt, postTokenForm } from "@/lib/oauth/token";
import type { ZoomReportParticipant } from "./zoomSessions";

const TOKEN_URL = "https://zoom.us/oauth/token";
const API = "https://api.zoom.us/v2";

export interface ZoomTokens {
  access_token: string;
  refresh_token: string;
  /** ISO timestamp. */
  expires_at: string;
}

async function tokenRequest(fields: Record<string, string>): Promise<ZoomTokens> {
  const { ok, status, body } = await postTokenForm<{
    access_token: string; refresh_token: string; expires_in: number; reason: string; error: string;
  }>(TOKEN_URL, fields, { basicAuth: { clientId: zoomClientId(), clientSecret: zoomClientSecret() } });
  if (!ok || !body.access_token || !body.refresh_token) {
    throw new UpstreamError(`Zoom token request failed (${status}): ${body.reason ?? body.error ?? "unknown"}`);
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: expiresAt(body.expires_in),
  };
}

/** The OAuth callback's code -> the account's first token pair. */
export function exchangeZoomCode(code: string, redirectUri: string): Promise<ZoomTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

export interface ZoomAccount {
  /** What webhook events carry as payload.account_id. */
  accountId: string;
  displayName: string | null;
}

/** Who connected: the account id events are matched by, and a label. No email is kept. */
export async function fetchZoomAccount(accessToken: string): Promise<ZoomAccount> {
  const res = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new UpstreamError(`Zoom user lookup failed (${res.status})`);
  const user = (await res.json()) as {
    account_id?: string; display_name?: string; first_name?: string; last_name?: string;
  };
  if (!user.account_id) throw new UpstreamError("Zoom returned no account id");
  const name = user.display_name || [user.first_name, user.last_name].filter(Boolean).join(" ");
  return { accountId: user.account_id, displayName: name || null };
}

/** A valid access token of the connection, refreshed (and saved) when due. */
function accessTokenFor(integrationId: string): Promise<string> {
  return connectionAccessToken(integrationId, "Zoom", (secrets) =>
    tokenRequest({ grant_type: "refresh_token", refresh_token: secrets.refresh_token }));
}

export type ZoomReport =
  | { status: "ok"; participants: ZoomReportParticipant[] }
  /** Zoom has no ended meeting under this id (yet). */
  | { status: "not-found" }
  /** The account's plan or the app's scopes do not include the report. */
  | { status: "unavailable"; reason: string };

/** Zoom wants a meeting uuid that starts with "/" or contains "//" encoded twice. */
function pastMeetingPath(meeting: string): string {
  const once = encodeURIComponent(meeting);
  return meeting.startsWith("/") || meeting.includes("//") ? encodeURIComponent(once) : once;
}

/**
 * Everyone who was in an ended meeting, all pages. `meeting` is the numeric
 * id (Zoom answers with the most recent ended occurrence) or the uuid of one
 * occurrence, which a call that created itself knows.
 */
export async function fetchPastParticipants(integrationId: string, meeting: string): Promise<ZoomReport> {
  const token = await accessTokenFor(integrationId);
  const participants: ZoomReportParticipant[] = [];
  let next = "";
  // 300 per page; a bounded loop even if Zoom kept returning a token.
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${API}/past_meetings/${pastMeetingPath(meeting)}/participants`);
    url.searchParams.set("page_size", "300");
    if (next) url.searchParams.set("next_page_token", next);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) return { status: "not-found" };
    const body = (await res.json().catch(() => ({}))) as {
      participants?: ZoomReportParticipant[]; next_page_token?: string; code?: number; message?: string;
    };
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // 3001 = meeting does not exist / has not ended; anything else is a plan or scope limit.
      if (body.code === 3001) return { status: "not-found" };
      return { status: "unavailable", reason: body.message ?? `Zoom answered ${res.status}` };
    }
    if (!res.ok) throw new UpstreamError(`Zoom participant report failed (${res.status})`);
    participants.push(...(body.participants ?? []));
    next = body.next_page_token ?? "";
    if (!next) break;
  }
  return { status: "ok", participants };
}
