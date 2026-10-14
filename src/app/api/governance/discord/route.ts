// Admin management of the community's proposal announcements webhook. The
// URL is a bearer secret: stored in a service-role-only table, tested once
// on save and never returned (only a masked hint).
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import { communityIdQuerySchema, communityIdSchema, setGovernanceDiscordWebhookSchema } from "@/lib/api/schemas";
import type { GovernanceDiscordWebhookResponse, OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { requireCommunity } from "@/lib/db/communities";
import {
  connectGovernanceWebhook, loadGovernanceWebhook, removeGovernanceWebhook,
} from "@/lib/discord/notifyProposals";
import { DiscordWebhookError } from "@/lib/discord/webhook";
import { BadRequestError } from "@/lib/errors";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, communityIdQuerySchema);
  await requireAdmin(communityId, session.wallet);
  return { webhook: await loadGovernanceWebhook(communityId) } satisfies GovernanceDiscordWebhookResponse;
});

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, url } = await parseJson(req, setGovernanceDiscordWebhookSchema);
  await requireAdmin(communityId, session.wallet);
  const community = await requireCommunity(communityId);
  try {
    const webhook = await connectGovernanceWebhook(community, url, session.wallet);
    return { webhook } satisfies GovernanceDiscordWebhookResponse;
  } catch (err) {
    if (err instanceof DiscordWebhookError) throw new BadRequestError(err.message);
    throw err;
  }
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { communityId } = await parseJson(req, communityIdSchema);
  await requireAdmin(communityId, session.wallet);
  await removeGovernanceWebhook(communityId);
  return { ok: true } satisfies OkResponse;
});
