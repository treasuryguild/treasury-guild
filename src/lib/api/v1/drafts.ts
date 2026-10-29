// draft_confirm: the one tool that carries out an agent API write. Every
// write is previewed first by its own `*_preview` tool, which runs the app's
// checks, writes nothing and returns a draft token naming the action; only
// after the user agrees does the assistant hand that token here. The token
// decides the action, so the action's own write scope is checked here, and
// each action re-checks its preview (a fingerprint) before doing anything.
// Confirming twice does it once: a create is keyed by the draft
// (agent_draft_id); a withdraw, task edit or finalize answers from the state.
import "server-only";

import { z } from "zod";
import { requireScope, type ApiCaller } from "@/lib/api/caller";
import type { V1DraftConfirmResponse } from "@/lib/api/types";
import { BadRequestError } from "@/lib/errors";
import { verifyDraftToken, type DraftAction, type VerifiedDraft } from "@/lib/mcp/draftToken";
import type { ApiScope } from "@/lib/mcp/scopes";
import { confirmCallCreate, confirmCallFinalize } from "./callWrite";
import { defineEndpoint } from "./endpoint";
import { confirmDrep, confirmStake, confirmVote } from "./governanceWrite";
import { confirmPayout } from "./payoutWrite";
import { confirmProposalWithdraw } from "./proposalWithdraw";
import { confirmProposalCreate } from "./proposalWrite";
import { communityInput } from "./shared";
import { confirmTaskSave } from "./taskWrite";

export interface DraftActionDef {
  /** The write scope a connection needs to carry the action out. */
  scope: ApiScope;
  confirm(caller: ApiCaller, draft: VerifiedDraft): Promise<object>;
}

/** Every action a draft can name, with its scope and what confirming it does. */
export const DRAFT_ACTION_DEFS: Record<DraftAction, DraftActionDef> = {
  proposal_create: { scope: "proposals:write", confirm: confirmProposalCreate },
  proposal_withdraw: { scope: "proposals:write", confirm: confirmProposalWithdraw },
  task_save: { scope: "tasks:write", confirm: confirmTaskSave },
  call_create: { scope: "tasks:write", confirm: confirmCallCreate },
  call_finalize: { scope: "tasks:write", confirm: confirmCallFinalize },
  payout_create: { scope: "payouts:write", confirm: confirmPayout },
  stake_create: { scope: "governance:write", confirm: confirmStake },
  drep_create: { scope: "governance:write", confirm: confirmDrep },
  vote_create: { scope: "governance:write", confirm: confirmVote },
};

/** The write scopes some action needs: holding any of them offers draft_confirm. */
export const DRAFT_SCOPES: readonly ApiScope[] = [...new Set(Object.values(DRAFT_ACTION_DEFS).map((d) => d.scope))];

export const confirmDraft = defineEndpoint({
  scope: DRAFT_SCOPES,
  input: z.object({
    draftToken: z.string().min(1).max(32_000).describe("The draftToken a *_preview tool returned"),
    community: communityInput.optional().describe("The previewed community's slug; taken from the token when omitted"),
  }),
  async run(caller, input): Promise<V1DraftConfirmResponse> {
    const draft = await verifyDraftToken(input.draftToken, caller);
    if (input.community && input.community !== draft.community) {
      throw new BadRequestError(`This draft was previewed for ${draft.community}, not ${input.community}`);
    }
    const action = DRAFT_ACTION_DEFS[draft.action];
    requireScope(caller, action.scope);
    return { action: draft.action, ...(await action.confirm(caller, draft)) } as V1DraftConfirmResponse;
  },
});
