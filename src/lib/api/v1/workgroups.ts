// A community's workgroups: who leads each and which treasury pays it.
import "server-only";

import { z } from "zod";
import type { V1WorkgroupsResponse } from "@/lib/api/types";
import { contributorLabel } from "@/lib/assignees";
import { TaskSource } from "@/lib/constants";
import { optionalRelation } from "@/lib/db/client";
import { listCommunityTreasuries } from "@/lib/db/treasuries";
import { listWorkgroupsWithLeads } from "@/lib/db/workgroups";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { appLink, communityInput, memberCommunity } from "./shared";

export const listWorkgroups = defineEndpoint({
  scope: "communities:read",
  input: z.object({
    community: communityInput,
    includeArchived: z.boolean().default(false),
  }),
  async run(caller, input): Promise<V1WorkgroupsResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const [workgroups, treasuries] = await Promise.all([
      listWorkgroupsWithLeads(community.id),
      listCommunityTreasuries(community.id),
    ]);
    const treasuryNames = new Map(treasuries.map((t) => [t.id, t.name]));

    return {
      community: { slug: community.slug, name: community.name },
      workgroups: workgroups
        .filter((w) => input.includeArchived || w.archived_at === null)
        .map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
          source: w.kind === TaskSource.Native ? "native" : "github",
          archived: w.archived_at !== null,
          treasury: w.treasury_id ? treasuryNames.get(w.treasury_id) ?? null : null,
          leads: w.workgroup_leads.map((lead) => {
            const profile = optionalRelation(lead.contributors);
            return {
              name: contributorLabel({
                wallet: lead.wallet_address,
                handle: profile?.handle ?? null,
                githubUsername: profile?.github_username ?? null,
              }),
              wallet: lead.wallet_address,
            };
          }),
          url: appLink(routes.board(community.slug, w.id)),
        })),
    };
  },
});
