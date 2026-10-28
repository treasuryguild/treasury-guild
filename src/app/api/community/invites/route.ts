// Admin management of community invite links: create, list, revoke.
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import {
  communityIdQuerySchema,
  createInviteSchema,
  revokeInviteSchema,
} from "@/lib/api/schemas";
import type {
  CreateInviteResponse,
  ListInvitesResponse,
  OkResponse,
} from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { createInvite, listInvites, revokeInvite } from "@/lib/db/invites";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { appUrl } from "@/lib/env.server";
import { inviteInfo } from "@/lib/invites/shape";
import { routes } from "@/lib/routes";

function inviteUrl(token: string): string {
  return `${appUrl().replace(/\/+$/, "")}${routes.invite(token)}`;
}

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, communityIdQuerySchema);
  await requireAdmin(communityId, session.wallet);
  const invites = await listInvites(communityId);
  return { invites: invites.map(inviteInfo) } satisfies ListInvitesResponse;
});

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, createInviteSchema);
  await requireAdmin(body.communityId, session.wallet);
  await enforceRateLimit("inviteCreate", session.wallet);
  const { invite, token } = await createInvite({
    communityId: body.communityId,
    createdBy: session.wallet,
    expiresInDays: body.expiresInDays,
    maxUses: body.maxUses,
    label: body.label,
  });
  return {
    invite: inviteInfo(invite),
    url: inviteUrl(token),
  } satisfies CreateInviteResponse;
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { communityId, inviteId } = await parseJson(req, revokeInviteSchema);
  await requireAdmin(communityId, session.wallet);
  await revokeInvite(inviteId, communityId);
  return { ok: true } satisfies OkResponse;
});
