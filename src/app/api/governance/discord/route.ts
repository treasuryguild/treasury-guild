// Admin management of the community's governance Discord channel. The
// Discord server comes from Call capture (call_integrations); this route
// only picks which text/forum channel the bot posts to.
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import { communityIdQuerySchema, communityIdSchema, setGovernanceDiscordChannelSchema } from "@/lib/api/schemas";
import type { GovernanceDiscordResponse, OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { requireCommunity } from "@/lib/db/communities";
import { DiscordBotError } from "@/lib/discord/bot";
import {
  connectGovernanceDiscordChannel, listGovernanceDiscordChannelOptions,
  loadGovernanceDiscordStatus, removeGovernanceDiscordChannel,
} from "@/lib/discord/notifyProposals";
import { BadRequestError } from "@/lib/errors";
import { z } from "zod";

const getQuerySchema = communityIdQuerySchema.extend({
  channels: z.enum(["1"]).optional(),
});

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId, channels } = parseQuery(req, getQuerySchema);
  await requireAdmin(communityId, session.wallet);
  const discord = await loadGovernanceDiscordStatus(communityId);
  if (!channels) return { discord } satisfies GovernanceDiscordResponse;
  try {
    return {
      discord,
      channels: await listGovernanceDiscordChannelOptions(communityId),
    } satisfies GovernanceDiscordResponse;
  } catch (err) {
    if (err instanceof DiscordBotError) throw new BadRequestError(err.message);
    throw err;
  }
});

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, channelId } = await parseJson(req, setGovernanceDiscordChannelSchema);
  await requireAdmin(communityId, session.wallet);
  const community = await requireCommunity(communityId);
  try {
    const discord = await connectGovernanceDiscordChannel(community, channelId, session.wallet);
    return { discord } satisfies GovernanceDiscordResponse;
  } catch (err) {
    if (err instanceof DiscordBotError) throw new BadRequestError(err.message);
    throw err;
  }
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { communityId } = await parseJson(req, communityIdSchema);
  await requireAdmin(communityId, session.wallet);
  await removeGovernanceDiscordChannel(communityId);
  return { ok: true } satisfies OkResponse;
});
