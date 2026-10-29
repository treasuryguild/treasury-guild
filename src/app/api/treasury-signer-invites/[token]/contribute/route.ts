// A listed signer connects and sends the stake address and optional DRep
// hash their wallet just reported. The session wallet is the only row written.
import { parseInput } from "@/lib/api/parse";
import { parseJson, sessionRoute } from "@/lib/api/route";
import { contributeSignerKeysSchema, inviteTokenSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { contributeSignerDraft } from "@/lib/db/signerDrafts";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const POST = sessionRoute<{ token: string }>(async (req, { params, session }) => {
  const token = parseInput(inviteTokenSchema, params.token);
  await enforceRateLimit("signerDraftContribute", session.wallet);
  const body = await parseJson(req, contributeSignerKeysSchema);
  await contributeSignerDraft(token, session.wallet, body.stakeAddress, body.drepKeyHash ?? null);
  return { ok: true } satisfies OkResponse;
});