// Calls through the agent API: creating a rewarded call, and paying a call's
// attendance into tasks. Each preview runs the app's own checks
// (src/lib/calls/create.ts, finalize.ts) and writes nothing; draft_confirm
// does it. A created call is keyed by its draft (calls.agent_draft_id, 0065);
// a finalize never pays anyone twice (finalize_call skips the rewarded).
import "server-only";

import { z } from "zod";
import type { ApiCaller } from "@/lib/api/caller";
import { createCallSchema } from "@/lib/api/schemas";
import { parseInput } from "@/lib/api/parse";
import type { V1CallCreateResponse, V1CallFinalizeResponse, V1DraftPreview } from "@/lib/api/types";
import { sha256Hex } from "@/lib/auth/crypto";
import { loadCallForManager } from "@/lib/calls/access";
import { checkCreateCall, createCall } from "@/lib/calls/create";
import { finalizeReady, planFinalize, type FinalizePlan } from "@/lib/calls/finalize";
import { CallProvider } from "@/lib/constants";
import { findCallByDraft, type CallWithWorkgroup } from "@/lib/db/calls";
import { taskNumbers } from "@/lib/db/tasks";
import { BadRequestError, ConflictError } from "@/lib/errors";
import { canonicalJson } from "@/lib/governance/rules";
import { mintDraftToken, type VerifiedDraft } from "@/lib/mcp/draftToken";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { CONFIRM_NEXT } from "./shape";
import { appLink, communityInput, memberCommunity, resolveCommunityWorkgroup } from "./shared";

const PLATFORM_NOTE: Record<string, string> = {
  [CallProvider.Discord]: "Attendance is read from the community's Discord voice channel while the call runs.",
  [CallProvider.Zoom]: "Attendance is read from the community's connected Zoom account.",
  [CallProvider.Meet]: "Attendance is read from the community's connected Google Meet account.",
  [CallProvider.Manual]: "Attendees check in themselves or are added by a manager.",
};

export const previewCallCreate = defineEndpoint({
  scope: "tasks:write",
  input: z.object({
    community: communityInput,
    workgroup: z.string().trim().min(1).max(200).describe("The workgroup the call belongs to: name or id"),
    provider: z.enum([CallProvider.Discord, CallProvider.Zoom, CallProvider.Meet, CallProvider.Manual])
      .describe("Where attendance comes from: discord, zoom, meet, or manual (check-in)"),
    title: z.string().trim().min(1).max(120),
    startsAt: z.string().describe("Start, ISO 8601 with a time zone offset, e.g. 2026-10-08T17:00:00Z"),
    endsAt: z.string().describe("End, ISO 8601 with a time zone offset"),
    reward: z.record(z.string(), z.string()).describe('Paid to each attendee who qualifies, ticker -> amount, e.g. {"ADA": "20"}'),
    meeting: z.string().trim().max(64).nullable().optional()
      .describe("The Discord voice channel id, Zoom meeting id or Meet code (abc-mnop-xyz) attendance is read from"),
    minSnapshots: z.number().int().min(0).max(100).optional().describe("Discord: voice-channel snapshots needed to qualify (default 1)"),
    minMinutes: z.number().int().min(0).max(24 * 60).optional().describe("Zoom and Meet: minutes needed to qualify (default 0)"),
  }),
  async run(caller, input): Promise<V1DraftPreview> {
    const { community } = await memberCommunity(caller, input.community);
    const workgroup = await resolveCommunityWorkgroup(community.id, input.workgroup);
    const request = parseInput(createCallSchema, {
      workgroupId: workgroup.id,
      provider: input.provider,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      amounts: input.reward,
      externalRef: input.meeting ?? null,
      ...(input.minSnapshots !== undefined ? { minSnapshots: input.minSnapshots } : {}),
      ...(input.minMinutes !== undefined ? { minMinutes: input.minMinutes } : {}),
    });
    await checkCreateCall(request, caller.wallet);
    const { token, expiresAt } = await mintDraftToken(caller, {
      action: "call_create",
      community: community.slug,
      request: request as unknown as Record<string, unknown>,
      fingerprint: sha256Hex(canonicalJson(request)),
      rulesHash: "",
    });
    return {
      community: { slug: community.slug, name: community.name },
      action: "call_create",
      summary: `Create the call "${request.title}" in ${workgroup.name}`,
      details: {
        workgroup: workgroup.name,
        provider: request.provider,
        title: request.title,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        reward: request.amounts,
        meeting: request.externalRef,
        minSnapshots: request.minSnapshots,
        minMinutes: request.minMinutes,
      },
      effects: [
        "Members see the call on the Calls page.",
        PLATFORM_NOTE[request.provider] ?? "",
        "Nobody is paid until a manager finalizes the call (call_finalize_preview), which turns qualifying attendees into tasks.",
      ].filter(Boolean),
      next: CONFIRM_NEXT,
      draftToken: token,
      expiresAt,
    };
  },
});

/** The call_create action, run by draft_confirm. */
export async function confirmCallCreate(caller: ApiCaller, draft: VerifiedDraft): Promise<V1CallCreateResponse> {
  const { community } = await memberCommunity(caller, draft.community);
  const request = parseInput(createCallSchema, draft.request);
  if (sha256Hex(canonicalJson(request)) !== draft.fingerprint) throw new BadRequestError("This draft is not valid: preview it again");
  const answer = (created: boolean, call: { id: string; title: string }): V1CallCreateResponse => ({
    community: { slug: community.slug, name: community.name },
    created,
    callId: call.id,
    title: call.title,
    url: appLink(routes.call(community.slug, call.id)),
  });
  const existing = await findCallByDraft(draft.draftId);
  if (existing) return answer(false, existing);
  // The workgroup must still be this community's: refused before the insert.
  const call = await createCall(request, caller.wallet, { agentDraftId: draft.draftId, communityId: community.id });
  if (call) return answer(true, call);
  // A concurrent confirm of the same draft won the insert: answer as a repeat.
  const raced = await findCallByDraft(draft.draftId);
  if (!raced) throw new ConflictError("The call could not be created. Preview it again.");
  return answer(false, raced);
}

const callIdInput = z.guid().describe("The call's id, as call_list returns it");

async function managedCall(communityId: string, callId: string, wallet: string): Promise<CallWithWorkgroup> {
  const call = await loadCallForManager(callId, wallet);
  if (call.community_id !== communityId) throw new BadRequestError("No such call in this community");
  return call;
}

function finalizeFingerprint(call: CallWithWorkgroup, plan: FinalizePlan): string {
  return sha256Hex(canonicalJson({ callId: call.id, amounts: call.amounts, attendees: plan.ready.map((a) => a.id).sort() }));
}

export const previewCallFinalize = defineEndpoint({
  scope: "tasks:write",
  input: z.object({ community: communityInput, call: callIdInput }),
  async run(caller, input): Promise<V1DraftPreview> {
    const { community } = await memberCommunity(caller, input.community);
    const call = await managedCall(community.id, input.call, caller.wallet);
    const plan = await planFinalize(call);
    if (plan.ready.length === 0) {
      throw new BadRequestError(
        `Nobody to reward on "${call.title}" right now: ${plan.standings.rewarded} already rewarded, ${plan.standings.unlinked} without a linked wallet, ${plan.standings["below-threshold"]} below the threshold`,
      );
    }
    const { token, expiresAt } = await mintDraftToken(caller, {
      action: "call_finalize",
      community: community.slug,
      request: { callId: call.id },
      fingerprint: finalizeFingerprint(call, plan),
      rulesHash: "",
    });
    return {
      community: { slug: community.slug, name: community.name },
      action: "call_finalize",
      summary: `Pay ${plan.ready.length} attendee${plan.ready.length === 1 ? "" : "s"} of "${call.title}" into ${plan.tasks} attendance task${plan.tasks === 1 ? "" : "s"}`,
      details: {
        call: call.title,
        startsAt: call.starts_at,
        rewardEach: call.amounts,
        attendees: plan.ready.map((a) => ({ name: a.display_name, wallet: a.wallet_address, minutes: a.minutes, snapshots: a.snapshots_seen })),
        tasks: plan.tasks,
        standings: plan.standings,
      },
      effects: [
        "The attendance tasks are created payable on the workgroup's board, one assignee per attendee: they go into the next payout.",
        "The call's reward is locked from then on.",
        "Attendees without a linked wallet stay on the list for a later finalize.",
      ],
      next: CONFIRM_NEXT,
      draftToken: token,
      expiresAt,
    };
  },
});

/** The call_finalize action, run by draft_confirm. */
export async function confirmCallFinalize(caller: ApiCaller, draft: VerifiedDraft): Promise<V1CallFinalizeResponse> {
  const { community } = await memberCommunity(caller, draft.community);
  const callId = typeof draft.request.callId === "string" ? draft.request.callId : "";
  const call = await managedCall(community.id, callId, caller.wallet);
  const plan = await planFinalize(call);
  const answer = (created: boolean, numbers: number[], paid: number, remaining: number): V1CallFinalizeResponse => ({
    community: { slug: community.slug, name: community.name },
    created,
    tasks: numbers,
    paid,
    remaining,
    url: appLink(routes.call(community.slug, call.id)),
  });
  // Confirmed before: everyone it would have paid has a task now.
  if (plan.ready.length === 0 && plan.standings.rewarded > 0) {
    return answer(false, [], 0, plan.standings.unlinked);
  }
  if (finalizeFingerprint(call, plan) !== draft.fingerprint) {
    throw new ConflictError("The call's attendance or reward changed since the preview. Preview the finalize again.");
  }
  const result = await finalizeReady(call, caller.wallet, plan.ready);
  return answer(result.taskIds.length > 0, await taskNumbers(result.taskIds), result.paid, result.remaining);
}
