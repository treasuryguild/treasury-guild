// Admin management of a CBOR / CIP-0146 import invite: create, read, update, discard.
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import {
  createImportDraftSchema,
  deleteImportDraftSchema,
  importDraftQuerySchema,
  saveImportDraftSchema,
} from "@/lib/api/schemas";
import type { ImportDraftResponse, ListImportDraftsResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { resolveRegistrationImport } from "@/lib/cardano/cip146Lookup";
import { decodeTreasuryCbor } from "@/lib/cardano/treasuryImport";
import { SignerGroup } from "@/lib/constants";
import { asNetwork } from "@/lib/config";
import { requireCommunity } from "@/lib/db/communities";
import {
  createImportDraft,
  deleteImportDraft,
  getImportDraft,
  listOpenImportDrafts,
  saveImportDraft,
} from "@/lib/db/importDrafts";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { requireActiveWorkgroup, workgroupCommunityId } from "@/lib/db/workgroups";
import { appUrl } from "@/lib/env.server";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { routes } from "@/lib/routes";

function inviteUrl(token: string): string {
  return `${appUrl().replace(/\/+$/, "")}${routes.treasuryImportInvite(token)}`;
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
  const query = parseQuery(req, importDraftQuerySchema);
  if (query.draftId) {
    const draft = await getImportDraft(query.draftId);
    if (!draft) throw new NotFoundError("Import invite not found");
    await requireAdmin(draft.communityId, session.wallet);
    return { draft } satisfies ImportDraftResponse;
  }
  await requireAdmin(query.communityId!, session.wallet);
  const drafts = await listOpenImportDrafts(query.communityId!);
  return { drafts } satisfies ListImportDraftsResponse;
});

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, createImportDraftSchema);
  await requireAdmin(body.communityId, session.wallet);
  await enforceRateLimit("importDraftCreate", session.wallet);
  const community = await requireCommunity(body.communityId);
  const network = asNetwork(community.network);
  const workgroupId = await assertWorkgroup(body.communityId, body.workgroupId);

  let scriptCbor: string;
  let stakeCredentialHash: string | null;
  let decoded;
  let participantNames: Record<string, { name: string }> = {};
  if (body.source.type === "cbor") {
    decoded = decodeTreasuryCbor(body.source.cbor);
    scriptCbor = decoded.scriptCbor;
    stakeCredentialHash = body.source.stakeCredentialHash?.toLowerCase() ?? null;
  } else {
    const discovered = await resolveRegistrationImport(network, body.source.txHash);
    decoded = discovered.decoded;
    scriptCbor = decoded.scriptCbor;
    stakeCredentialHash = discovered.stakeCredentialHash;
    participantNames = discovered.participants;
  }

  const { shape } = decoded;
  const names = body.signerNames ?? {};
  const nameOf = (keyHash: string) =>
    names[keyHash] ?? names[keyHash.toLowerCase()] ?? participantNames[keyHash.toLowerCase()]?.name ?? "";

  const { draft, token } = await createImportDraft({
    communityId: body.communityId,
    createdBy: session.wallet,
    name: body.name,
    workgroupId,
    network,
    scriptCbor,
    stakeCredentialHash,
    signers: [
      ...shape.base.keyHashes.map((k) => ({
        keyHash: k,
        group: SignerGroup.Base,
        name: nameOf(k),
      })),
      ...(shape.recovery?.keyHashes ?? []).map((k) => ({
        keyHash: k,
        group: SignerGroup.Recovery,
        name: nameOf(k),
      })),
      ...(shape.cosignerKeyHash
        ? [{ keyHash: shape.cosignerKeyHash, group: SignerGroup.Cosigner, name: nameOf(shape.cosignerKeyHash) }]
        : []),
    ],
  });
  return { draft, url: inviteUrl(token) } satisfies ImportDraftResponse;
});

export const PATCH = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, saveImportDraftSchema);
  await requireAdmin(body.communityId, session.wallet);
  const workgroupId = await assertWorkgroup(body.communityId, body.workgroupId);
  const draft = await saveImportDraft({
    draftId: body.draftId,
    communityId: body.communityId,
    name: body.name,
    workgroupId,
  });
  return { draft } satisfies ImportDraftResponse;
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { draftId } = await parseJson(req, deleteImportDraftSchema);
  const draft = await getImportDraft(draftId);
  if (!draft) throw new NotFoundError("Import invite not found");
  await requireAdmin(draft.communityId, session.wallet);
  await deleteImportDraft(draftId);
  return { ok: true as const };
});
