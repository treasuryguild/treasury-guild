// Who the caller is, and which communities they belong to.
import "server-only";

import { z } from "zod";
import type { V1CommunitiesResponse, V1MeResponse } from "@/lib/api/types";
import { asNetwork, networkName } from "@/lib/config";
import { communitiesForWallet } from "@/lib/db/membership";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { appLink } from "./shared";

export const whoami = defineEndpoint({
  scope: "communities:read",
  input: z.object({}),
  async run(caller): Promise<V1MeResponse> {
    return { wallet: caller.wallet, client: caller.clientId, scopes: caller.scopes };
  },
});

export const listCommunities = defineEndpoint({
  scope: "communities:read",
  input: z.object({}),
  async run(caller): Promise<V1CommunitiesResponse> {
    const memberships = await communitiesForWallet(caller.wallet);
    return {
      communities: memberships.map(({ role, community }) => ({
        slug: community.slug,
        name: community.name,
        description: community.description,
        network: networkName(asNetwork(community.network)),
        visibility: community.visibility,
        role,
        url: appLink(routes.community(community.slug)),
      })),
    };
  },
});
