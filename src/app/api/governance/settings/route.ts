// An admin saves one proposal kind's settings: whether it is on, who may
// propose, who votes and how. Proposals already made keep the rules they
// were made with.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { saveGovernanceSettingsSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { saveGovernanceSettings } from "@/lib/db/governance";
import { LIVE_PROPOSAL_KINDS } from "@/lib/governance/rules";
import { BadRequestError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, kind, settings } = await parseJson(req, saveGovernanceSettingsSchema);
  await requireAdmin(communityId, session.wallet);
  if (!LIVE_PROPOSAL_KINDS.includes(kind)) throw new BadRequestError("This kind of proposal is not available yet");
  await saveGovernanceSettings(communityId, kind, settings, session.wallet);
  return { ok: true } satisfies OkResponse;
});
