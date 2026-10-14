// The pending transactions, across the caller's communities, that the
// caller's signature counts on: what is waiting for them to sign in the app.
import "server-only";

import { z } from "zod";
import type { V1SigningQueueItem, V1SigningQueueResponse } from "@/lib/api/types";
import { pathParticipants, pathRule } from "@/lib/cardano/spendingPaths";
import { requiredSignatures, thresholdReached } from "@/lib/cardano/thresholds";
import { communitiesForWallet } from "@/lib/db/membership";
import { loadPendingTransactions } from "@/lib/db/transactions";
import { listCommunityTreasuries, type TreasuryWithSigners } from "@/lib/db/treasuries";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { appLink } from "./shared";

export const signingQueue = defineEndpoint({
  scope: "communities:read",
  input: z.object({}),
  async run(caller): Promise<V1SigningQueueResponse> {
    const memberships = await communitiesForWallet(caller.wallet);
    const treasuries = new Map<string, { treasury: TreasuryWithSigners; community: { slug: string; name: string } }>();
    await Promise.all(memberships.map(async ({ community }) => {
      for (const treasury of await listCommunityTreasuries(community.id)) {
        treasuries.set(treasury.id, { treasury, community: { slug: community.slug, name: community.name } });
      }
    }));

    const pending = await loadPendingTransactions([...treasuries.keys()]);
    const items: V1SigningQueueItem[] = [];
    for (const tx of pending) {
      const owner = treasuries.get(tx.treasury_id);
      if (!owner) continue;
      const { treasury, community } = owner;
      const rule = pathRule(treasury, treasury.treasury_signers, tx.spending_path);
      // Only the path's own signers: a signature from anyone else never counts.
      if (!pathParticipants(rule).includes(caller.wallet)) continue;
      items.push({
        community,
        treasury: treasury.name,
        id: tx.id,
        kind: tx.kind,
        description: tx.description,
        spendingPath: tx.spending_path,
        signatures: tx.signed_addresses.length,
        requiredSignatures: requiredSignatures(rule),
        rejections: tx.rejected_addresses.length,
        signedByMe: tx.signed_addresses.includes(caller.wallet),
        rejectedByMe: tx.rejected_addresses.includes(caller.wallet),
        readyToSubmit: thresholdReached(rule, tx.signed_addresses),
        createdAt: tx.created_at,
        url: appLink(routes.tx(community.slug, tx.id)),
      });
    }
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return {
      transactions: items,
      waitingOnMe: items.filter((t) => !t.signedByMe && !t.rejectedByMe).length,
    };
  },
});
