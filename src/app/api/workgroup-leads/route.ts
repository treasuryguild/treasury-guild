import { parseJson, sessionRoute } from "@/lib/api/route";
import {
  workgroupLeadAddSchema,
  workgroupLeadDeleteSchema,
} from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireWorkgroupAdmin } from "@/lib/authz";
import { addMember } from "@/lib/db/membership";
import { addWorkgroupLead, removeWorkgroupLead } from "@/lib/db/workgroups";

// Admin assignment of workgroup leads. Leads can prep payouts and manage
// tasks/columns for their workgroups; signing stays treasury-signer-only.

export const POST = sessionRoute(async (req, { session }) => {
  const { workgroupId, wallet: lead } = await parseJson(
    req,
    workgroupLeadAddSchema,
  );
  const communityId = await requireWorkgroupAdmin(workgroupId, session.wallet);

  // A lead must at least be a member; existing roles are kept.
  await addMember(communityId, lead);
  await addWorkgroupLead(workgroupId, lead);
  return { ok: true } satisfies OkResponse;
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { workgroupId, wallet: lead } = await parseJson(
    req,
    workgroupLeadDeleteSchema,
  );
  await requireWorkgroupAdmin(workgroupId, session.wallet);

  await removeWorkgroupLead(workgroupId, lead);
  return { ok: true } satisfies OkResponse;
});
