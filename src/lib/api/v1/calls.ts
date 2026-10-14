// A community's rewarded calls: when, which workgroup, the reward, and how its
// attendees stand. With one call's id, its attendee list as members see it on
// the call page (names, minutes, snapshots, status, the task that paid them).
// Linked platform accounts and the ids captured from Discord, Zoom or Meet are
// never part of it (CALL_ATTENDEE_COLUMNS, see listCommunityCalls).
import "server-only";

import { z } from "zod";
import type { V1Call, V1CallsResponse } from "@/lib/api/types";
import { attendeeStanding, countStandings } from "@/lib/calls/qualify";
import { CallState } from "@/lib/constants";
import { optionalRelation } from "@/lib/db/client";
import { listCommunityCalls, type CallListing } from "@/lib/db/calls";
import { taskNumberMap } from "@/lib/db/tasks";
import { NotFoundError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { appLink, communityInput, memberCommunity } from "./shared";

export const CALL_LIST_MAX = 100;

function describeCall(slug: string, call: CallListing): V1Call {
  return {
    id: call.id,
    title: call.title,
    workgroup: optionalRelation(call.workgroups)?.name ?? null,
    platform: call.provider,
    startsAt: call.starts_at,
    endsAt: call.ends_at,
    rewardEach: call.amounts,
    threshold: { snapshots: call.min_snapshots, minutes: call.min_minutes },
    state: call.state,
    attendees: countStandings(call, call.call_attendees),
    url: appLink(routes.call(slug, call.id)),
  };
}

export const listCalls = defineEndpoint({
  scope: "communities:read",
  input: z.object({
    community: communityInput,
    state: z.enum([CallState.Open, CallState.Finalized]).optional()
      .describe("open: attendance not paid yet; finalized: attendance paid into tasks"),
    call: z.guid().optional().describe("One call's id: adds its attendee list"),
    limit: z.coerce.number().int().min(1).max(CALL_LIST_MAX).default(20)
      .describe("Newest calls first, at most this many"),
  }),
  async run(caller, input): Promise<V1CallsResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const calls = await listCommunityCalls(community.id, {
      state: input.state,
      callId: input.call,
      limit: input.call ? 1 : input.limit,
    });
    if (input.call && calls.length === 0) throw new NotFoundError("No such call in this community");

    let attendees: V1CallsResponse["attendees"] = null;
    if (input.call) {
      const call = calls[0]!;
      const numbers = await taskNumberMap(call.call_attendees.flatMap((a) => (a.task_id ? [a.task_id] : [])));
      attendees = call.call_attendees.map((a) => ({
        name: a.display_name,
        wallet: a.wallet_address,
        source: a.provider,
        minutes: a.minutes,
        snapshots: a.snapshots_seen,
        status: a.status,
        standing: attendeeStanding(call, a),
        task: a.task_id ? numbers.get(a.task_id) ?? null : null,
      }));
    }

    return {
      community: { slug: community.slug, name: community.name },
      calls: calls.map((c) => describeCall(community.slug, c)),
      attendees,
      url: appLink(routes.calls(community.slug)),
    };
  },
});
