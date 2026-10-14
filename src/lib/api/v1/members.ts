// A community's members as members see them in the app: name, role, wallet,
// GitHub login and the workgroups they lead. Linked Discord or Google
// accounts are never part of it (contributor_identities shows a wallet only
// its own rows).
import "server-only";

import { z } from "zod";
import type { V1MembersResponse } from "@/lib/api/types";
import { listWorkgroupsWithLeads } from "@/lib/db/workgroups";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { appLink, communityInput, communityMemberRefs, memberCommunity, memberName } from "./shared";

export const listMembers = defineEndpoint({
  scope: "communities:read",
  input: z.object({ community: communityInput }),
  async run(caller, input): Promise<V1MembersResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const [members, workgroups] = await Promise.all([
      communityMemberRefs(community.id),
      listWorkgroupsWithLeads(community.id),
    ]);
    const leads = new Map<string, string[]>();
    for (const w of workgroups) {
      if (w.archived_at !== null) continue;
      for (const lead of w.workgroup_leads) leads.set(lead.wallet_address, [...(leads.get(lead.wallet_address) ?? []), w.name]);
    }
    return {
      community: { slug: community.slug, name: community.name },
      members: members.map((m) => ({
        name: memberName(m),
        role: m.role,
        wallet: m.wallet,
        githubUsername: m.githubUsername,
        leads: leads.get(m.wallet) ?? [],
      })),
      url: appLink(routes.community(community.slug)),
    };
  },
});
