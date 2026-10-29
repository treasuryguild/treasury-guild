import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endpointScopes } from "@/lib/api/v1/endpoint";
import { API_SCOPES, isWriteScope, READ_SCOPES } from "./scopes";
import { MCP_TOOLS, toolsForScopes } from "./tools";

const PREVIEWS = [
  "proposal_preview", "proposal_withdraw_preview", "task_preview", "call_create_preview", "call_finalize_preview",
  "payout_preview", "stake_preview", "drep_preview", "vote_preview",
];

describe("MCP tool registry", () => {
  it("pins the tools: a write tool is a deliberate change to this list, never a quiet addition", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      "guild_whoami", "community_list", "treasury_overview", "task_list", "budget_summary", "proposal_list",
      "signing_queue", "transaction_list", "workgroup_list", "incoming_list", "member_list",
      "transaction_detail", "funding_summary", "call_list", "proposal_detail",
      "proposal_preview", "proposal_create",
      "proposal_withdraw_preview", "task_preview", "call_create_preview", "call_finalize_preview", "payout_preview",
      "stake_preview", "drep_preview", "vote_preview",
      "draft_confirm",
    ]);
    // Only these two carry anything out, and only from a preview's draft token.
    expect(MCP_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(["proposal_create", "draft_confirm"]);
  });

  it("puts every tool that writes, or prepares a write, behind write scopes only", () => {
    const writeScoped = MCP_TOOLS.filter((t) => endpointScopes(t.endpoint).every(isWriteScope)).map((t) => t.name);
    expect(writeScoped.sort()).toEqual([...PREVIEWS, "proposal_create", "draft_confirm"].sort());
    for (const tool of MCP_TOOLS) {
      if (!tool.annotations.readOnlyHint) {
        expect(endpointScopes(tool.endpoint).every(isWriteScope), tool.name).toBe(true);
      }
    }
    expect(toolsForScopes(READ_SCOPES).map((t) => t.name)).not.toEqual(expect.arrayContaining(["draft_confirm"]));
    for (const name of PREVIEWS) expect(toolsForScopes(READ_SCOPES).map((t) => t.name)).not.toContain(name);
  });

  it("offers each write scope its own previews, and draft_confirm with any of them", () => {
    const names = (scope: (typeof API_SCOPES)[number]) => toolsForScopes([scope]).map((t) => t.name);
    expect(names("payouts:write")).toEqual(["payout_preview", "draft_confirm"]);
    expect(names("tasks:write")).toEqual(["task_preview", "call_create_preview", "call_finalize_preview", "draft_confirm"]);
    expect(names("proposals:write")).toEqual(["proposal_preview", "proposal_create", "proposal_withdraw_preview", "draft_confirm"]);
    expect(names("governance:write")).toEqual(["stake_preview", "drep_preview", "vote_preview", "draft_confirm"]);
  });

  it("serves every tool's endpoint over /api/v1 as well", () => {
    for (const tool of MCP_TOOLS) {
      const dir = tool.restPath.replace(/^\/api\//, "").replace(/\{(\w+)\}/g, "[$1]");
      expect(existsSync(join(process.cwd(), "src", "app", "api", dir, "route.ts")), tool.restPath).toBe(true);
    }
  });

  it("offers a caller only the tools its scopes allow", () => {
    expect(toolsForScopes([])).toEqual([]);
    expect(toolsForScopes(API_SCOPES)).toHaveLength(MCP_TOOLS.length);
  });

  it("uses unique tool names", () => {
    expect(new Set(MCP_TOOLS.map((t) => t.name)).size).toBe(MCP_TOOLS.length);
  });
});
