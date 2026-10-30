import { parseJson, sessionRoute } from "@/lib/api/route";
import {
  workgroupLeadAddSchema,
  workgroupLeadDeleteSchema,
} from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireWorkgroupAdmin } from "@/lib/authz";
import { ProposalKind } from "@/lib/constants";
import { loadGovernanceSettings } from "@/lib/db/governance";
import { addMember } from "@/lib/db/membership";
import { addWorkgroupLead, removeWorkgroupLead, removeWorkgroupLeadOverride } from "@/lib/db/workgroups";
import { BadRequestError, ConflictError } from "@/lib/errors";

// Admin assignment of workgroup leads. While new workgroups are decided by
// vote, adds go through a lead-change proposal and a removal needs a reason.
// Leads can prep payouts and manage tasks; signing stays treasury-signer-only.

const VOTE_ON = "Lead changes are proposed while new workgroups are decided by vote";

export const POST = sessionRoute(async (req, { session }) => {
  const { workgroupId, wallet: lead } = await parseJson(
    req,
    workgroupLeadAddSchema,
  );
  const communityId = await requireWorkgroupAdmin(workgroupId, session.wallet);
  if ((await loadGovernanceSettings(communityId, ProposalKind.Workgroup)).enabled) {
    throw new ConflictError(VOTE_ON);
  }

  // A lead must at least be a member; existing roles are kept.
  await addMember(communityId, lead);
  await addWorkgroupLead(workgroupId, lead);
  return { ok: true } satisfies OkResponse;
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { workgroupId, wallet: lead, reason } = await parseJson(
    req,
    workgroupLeadDeleteSchema,
  );
  const communityId = await requireWorkgroupAdmin(workgroupId, session.wallet);
  if ((await loadGovernanceSettings(communityId, ProposalKind.Workgroup)).enabled) {
    if (!reason) throw new BadRequestError("Give a reason for removing this lead");
    await removeWorkgroupLeadOverride(workgroupId, lead, session.wallet, reason);
  } else {
    await removeWorkgroupLead(workgroupId, lead);
  }
  return { ok: true } satisfies OkResponse;
});
