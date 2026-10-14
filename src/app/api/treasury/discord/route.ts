// Admin management of a treasury's Discord webhook. The URL is a bearer
// secret: it is stored in a service-role-only table, tested once on save and
// never returned to the client (only a masked hint).
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import {
  communityIdQuerySchema,
  deleteTreasuryDiscordWebhookSchema,
  setTreasuryDiscordWebhookSchema,
} from "@/lib/api/schemas";
import type {
  OkResponse,
  SetTreasuryDiscordWebhookResponse,
  TreasuryDiscordWebhookStatus,
  TreasuryDiscordWebhooksResponse,
} from "@/lib/api/types";
import { requireAdmin, requireTreasuryAdmin } from "@/lib/authz";
import {
  deleteTreasuryDiscordWebhook,
  listTreasuryDiscordWebhooks,
  saveTreasuryDiscordWebhook,
  type TreasuryDiscordWebhook,
} from "@/lib/db/treasuries";
import { buildConnectedEmbed } from "@/lib/discord/payoutMessage";
import { DiscordWebhookError, postDiscordWebhook, webhookUrlHint } from "@/lib/discord/webhook";
import { BadRequestError } from "@/lib/errors";

function toStatus(row: TreasuryDiscordWebhook): TreasuryDiscordWebhookStatus {
  return {
    treasuryId: row.treasury_id,
    urlHint: webhookUrlHint(row.url),
    lastPostedAt: row.last_posted_at,
    lastError: row.last_error,
  };
}

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, communityIdQuerySchema);
  await requireAdmin(communityId, session.wallet);

  const webhooks = await listTreasuryDiscordWebhooks(communityId);
  return { webhooks: webhooks.map(toStatus) } satisfies TreasuryDiscordWebhooksResponse;
});

export const POST = sessionRoute(async (req, { session }) => {
  const { treasuryId, url } = await parseJson(req, setTreasuryDiscordWebhookSchema);
  const treasury = await requireTreasuryAdmin(treasuryId, session.wallet);

  // Prove the URL works before storing it: the channel gets a hello message.
  try {
    await postDiscordWebhook(url, buildConnectedEmbed(treasury.name));
  } catch (err) {
    if (err instanceof DiscordWebhookError) throw new BadRequestError(err.message);
    throw err;
  }

  const now = new Date().toISOString();
  await saveTreasuryDiscordWebhook({ treasuryId, url, actor: session.wallet, now });

  return {
    webhook: toStatus({ treasury_id: treasuryId, url, last_posted_at: now, last_error: null }),
  } satisfies SetTreasuryDiscordWebhookResponse;
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { treasuryId } = await parseJson(req, deleteTreasuryDiscordWebhookSchema);
  await requireTreasuryAdmin(treasuryId, session.wallet);

  await deleteTreasuryDiscordWebhook(treasuryId);
  return { ok: true } satisfies OkResponse;
});
