// Discord incoming webhooks: one POST per message. Server-only because the
// webhook URL is a bearer secret (anyone holding it can post to the channel).
import "server-only";

import { appUrl } from "@/lib/env.server";
import { errorMessage } from "@/lib/errors";
import { AVATAR_PATH, type DiscordWebhookPayload } from "./payoutMessage";

/**
 * `permanent` = retrying the same request will not help (webhook deleted or
 * token revoked → 401/403/404, payload rejected → other 4xx). Transient
 * failures (429, 5xx, network) are left for the next cron sweep.
 */
export class DiscordWebhookError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly permanent: boolean,
  ) {
    super(message);
    this.name = "DiscordWebhookError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const BODY_EXCERPT = 200;

function defaultAvatarUrl(): string {
  return `${appUrl().replace(/\/+$/, "")}${AVATAR_PATH}`;
}

export async function postDiscordWebhook(
  url: string,
  payload: DiscordWebhookPayload,
  fetchImpl: FetchLike = (u, init) => fetch(u, init),
): Promise<void> {
  const body: DiscordWebhookPayload = {
    ...payload,
    avatar_url: payload.avatar_url ?? defaultAvatarUrl(),
  };
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new DiscordWebhookError(
      `Discord unreachable: ${errorMessage(err)}`,
      null,
      false,
    );
  }
  if (res.ok) return;

  const excerpt = (await res.text().catch(() => "")).slice(0, BODY_EXCERPT);
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
  const what =
    res.status === 401 || res.status === 403 || res.status === 404
      ? "Discord webhook not found (deleted or wrong URL?)"
      : `Discord answered ${res.status}`;
  throw new DiscordWebhookError(
    excerpt ? `${what}: ${excerpt}` : what,
    res.status,
    permanent,
  );
}

/** What admins see instead of the secret: `…/webhooks/<id>/••••<last 4>`. */
export function webhookUrlHint(url: string): string {
  const m = /\/webhooks\/(\d+)\/([\w-]+)$/.exec(url);
  if (!m) return "…/webhooks/••••";
  return `…/webhooks/${m[1]}/••••${m[2]!.slice(-4)}`;
}
