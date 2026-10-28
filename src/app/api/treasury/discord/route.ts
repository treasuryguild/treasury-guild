// Admin management of a treasury's Discord payout destination: either a
// pasted incoming-webhook URL or a text/announcement channel on the
// community's connected Discord server. The webhook URL is a bearer secret
// and is never returned to the client (only a masked hint).
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import {
  communityIdQuerySchema,
  deleteTreasuryDiscordDestinationSchema,
  setTreasuryDiscordDestinationSchema,
} from "@/lib/api/schemas";
import type {
  OkResponse,
  SetTreasuryDiscordDestinationResponse,
  TreasuryDiscordDestinationStatus,
  TreasuryDiscordDestinationsResponse,
} from "@/lib/api/types";
import { requireAdmin, requireTreasuryAdmin } from "@/lib/authz";
import {
  deleteTreasuryDiscordDestination,
  listTreasuryDiscordDestinations,
  saveTreasuryDiscordWebhook,
  type TreasuryDiscordDestination,
} from "@/lib/db/treasuries";
import { DiscordBotError } from "@/lib/discord/bot";
import { buildConnectedEmbed } from "@/lib/discord/payoutMessage";
import {
  connectTreasuryDiscordChannel,
  listTreasuryDiscordChannelOptions,
} from "@/lib/discord/treasuryDestination";
import { DiscordWebhookError, postDiscordWebhook, webhookUrlHint } from "@/lib/discord/webhook";
import { BadRequestError } from "@/lib/errors";
import { z } from "zod";

const getQuerySchema = communityIdQuerySchema.extend({
  channels: z.enum(["1"]).optional(),
});

function toStatus(row: TreasuryDiscordDestination): TreasuryDiscordDestinationStatus {
  if (row.url) {
    return {
      treasuryId: row.treasury_id,
      mode: "webhook",
      urlHint: webhookUrlHint(row.url),
      lastPostedAt: row.last_posted_at,
      lastError: row.last_error,
    };
  }
  return {
    treasuryId: row.treasury_id,
    mode: "channel",
    channelId: row.channel_id ?? undefined,
    channelType: row.channel_type ?? undefined,
    lastPostedAt: row.last_posted_at,
    lastError: row.last_error,
  };
}

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId, channels } = parseQuery(req, getQuerySchema);
  await requireAdmin(communityId, session.wallet);

  const destinations = (await listTreasuryDiscordDestinations(communityId)).map(toStatus);
  if (!channels) return { destinations } satisfies TreasuryDiscordDestinationsResponse;
  try {
    return {
      destinations,
      channels: await listTreasuryDiscordChannelOptions(communityId),
    } satisfies TreasuryDiscordDestinationsResponse;
  } catch (err) {
    if (err instanceof DiscordBotError) throw new BadRequestError(err.message);
    throw err;
  }
});

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, setTreasuryDiscordDestinationSchema);
  const treasury = await requireTreasuryAdmin(body.treasuryId, session.wallet);

  if ("url" in body) {
    try {
      await postDiscordWebhook(body.url, buildConnectedEmbed(treasury.name));
    } catch (err) {
      if (err instanceof DiscordWebhookError) throw new BadRequestError(err.message);
      throw err;
    }
    const now = new Date().toISOString();
    await saveTreasuryDiscordWebhook({
      treasuryId: body.treasuryId,
      url: body.url,
      actor: session.wallet,
      now,
    });
    return {
      destination: toStatus({
        treasury_id: body.treasuryId,
        url: body.url,
        channel_id: null,
        channel_type: null,
        last_posted_at: now,
        last_error: null,
      }),
    } satisfies SetTreasuryDiscordDestinationResponse;
  }

  try {
    const { destination } = await connectTreasuryDiscordChannel(
      treasury,
      body.channelId,
      session.wallet,
    );
    return { destination: toStatus(destination) } satisfies SetTreasuryDiscordDestinationResponse;
  } catch (err) {
    if (err instanceof DiscordBotError) throw new BadRequestError(err.message);
    throw err;
  }
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { treasuryId } = await parseJson(req, deleteTreasuryDiscordDestinationSchema);
  await requireTreasuryAdmin(treasuryId, session.wallet);

  await deleteTreasuryDiscordDestination(treasuryId);
  return { ok: true } satisfies OkResponse;
});
