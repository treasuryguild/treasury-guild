// Admin management of an SDK signer invite: create, read, update, discard.
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import {
  createSignerDraftSchema,
  deleteSignerDraftSchema,
  saveSignerDraftSchema,
  signerDraftQuerySchema,
} from "@/lib/api/schemas";
import type { ListSignerDraftsResponse, OkResponse, SignerDraftResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { asNetwork } from "@/lib/config";
import { requireCommunity } from "@/lib/db/communities";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import {
  createSignerDraft,
  deleteSignerDraft,
  getSignerDraft,
  listOpenSignerDrafts,
  saveSignerDraft,
} from "@/lib/db/signerDrafts";
import { requireActiveWorkgroup, workgroupCommunityId } from "@/lib/db/workgroups";
import { appUrl } from "@/lib/env.server";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { routes } from "@/lib/routes";

function inviteUrl(token: string): string {
  return `${appUrl().replace(/\/+$/, "")}${routes.treasurySignerInvite(token)}`;
}

async function assertWorkgroup(communityId: string, workgroupId: string | null | undefined): Promise<string | null> {
  if (!workgroupId) return null;
  if ((await workgroupCommunityId(workgroupId)) !== communityId) {
    throw new BadRequestError("Choose a workgroup of this community");
  }
  await requireActiveWorkgroup(workgroupId);
  return workgroupId;
}

export const GET = sessionRoute(async (req, { session }) => {
  const query = parseQuery(req, signerDraftQuerySchema);
  if (query.draftId) {
    const draft = await getSignerDraft(query.draftId);
    if (!draft) throw new NotFoundError("Signer invite not found");
    await requireAdmin(draft.communityId, session.wallet);
    return { draft } satisfies SignerDraftResponse;
  }
  await requireAdmin(query.communityId!, session.wallet);
  const drafts = await listOpenSignerDrafts(query.communityId!);
  return { drafts } satisfies ListSignerDraftsResponse;
});

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, createSignerDraftSchema);
  await requireAdmin(body.communityId, session.wallet);
  await enforceRateLimit("signerDraftCreate", session.wallet);
  const community = await requireCommunity(body.communityId);
  const workgroupId = await assertWorkgroup(body.communityId, body.workgroupId);
  const { draft, token } = await createSignerDraft({
    communityId: body.communityId,
    createdBy: session.wallet,
    name: body.name,
    required: body.required,
    workgroupId,
    network: asNetwork(community.network),
    // Keys for anyone but the signed-in wallet are dropped again in SQL.
    signers: body.signers.map((s) =>
      s.address === session.wallet
        ? { address: s.address, name: s.name, stakeAddress: s.stakeAddress, drepKeyHash: s.drepKeyHash }
        : { address: s.address, name: s.name },
    ),
  });
  return { draft, url: inviteUrl(token) } satisfies SignerDraftResponse;
});

export const PATCH = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, saveSignerDraftSchema);
  await requireAdmin(body.communityId, session.wallet);
  const community = await requireCommunity(body.communityId);
  const workgroupId = await assertWorkgroup(body.communityId, body.workgroupId);
  const own = body.signers.find((s) => s.address === session.wallet);
  const draft = await saveSignerDraft({
    draftId: body.draftId,
    communityId: body.communityId,
    actor: session.wallet,
    name: body.name,
    required: body.required,
    workgroupId,
    network: asNetwork(community.network),
    signers: body.signers.map((s) =>
      s.address === session.wallet
        ? { address: s.address, name: s.name, stakeAddress: own?.stakeAddress, drepKeyHash: own?.drepKeyHash }
        : { address: s.address, name: s.name },
    ),
  });
  return { draft } satisfies SignerDraftResponse;
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { draftId } = await parseJson(req, deleteSignerDraftSchema);
  const draft = await getSignerDraft(draftId);
  if (!draft) throw new NotFoundError("Signer invite not found");
  await requireAdmin(draft.communityId, session.wallet);
  await deleteSignerDraft(draftId);
  return { ok: true } satisfies OkResponse;
});
