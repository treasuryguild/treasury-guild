// A script signer connects and claims the key-hash slot that matches their
// payment key. The session wallet is the only row written.
import { parseInput } from "@/lib/api/parse";
import { parseJson, sessionRoute } from "@/lib/api/route";
import { claimImportInviteSchema, inviteTokenSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { claimImportDraft } from "@/lib/db/importDrafts";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const POST = sessionRoute<{ token: string }>(async (req, { params, session }) => {
  const token = parseInput(inviteTokenSchema, params.token);
  await enforceRateLimit("importDraftClaim", session.wallet);
  const body = await parseJson(req, claimImportInviteSchema);
  await claimImportDraft(token, session.wallet, body.name ?? null);
  return { ok: true } satisfies OkResponse;
});
