import { describe, expect, it } from "vitest";
import { DRAFT_ACTIONS } from "@/lib/mcp/draftToken";
import { API_SCOPES, isWriteScope } from "@/lib/mcp/scopes";
import { confirmDraft, DRAFT_ACTION_DEFS, DRAFT_SCOPES } from "./drafts";
import { endpointScopes } from "./endpoint";

describe("draft actions", () => {
  it("defines every action a draft token can name, each behind its own write scope", () => {
    expect(Object.keys(DRAFT_ACTION_DEFS).sort()).toEqual([...DRAFT_ACTIONS].sort());
    // What draft_confirm re-checks after reading the token: a connection
    // granted one write scope never carries out another scope's draft.
    expect(Object.fromEntries(Object.entries(DRAFT_ACTION_DEFS).map(([action, def]) => [action, def.scope]))).toEqual({
      proposal_create: "proposals:write",
      proposal_withdraw: "proposals:write",
      task_save: "tasks:write",
      call_create: "tasks:write",
      call_finalize: "tasks:write",
      payout_create: "payouts:write",
      stake_create: "governance:write",
      drep_create: "governance:write",
      vote_create: "governance:write",
    });
  });

  it("offers draft_confirm to exactly the write scopes, and never to a read scope", () => {
    expect([...DRAFT_SCOPES].sort()).toEqual(API_SCOPES.filter(isWriteScope).sort());
    expect(endpointScopes(confirmDraft)).toBe(DRAFT_SCOPES);
  });
});
