"use client";

import { use } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/client";
import type { JoinCommunityResponse } from "@/lib/api/types";
import { Visibility } from "@/lib/constants";
import { COMMUNITY_CARDS, communityHref, routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useTreasuries } from "@/hooks/useTreasuries";
import { CommunityAvatar } from "@/components/community/CommunityAvatar";
import { NetworkBadge } from "@/components/community/NetworkNotice";
import { OverviewAttention } from "@/components/community/OverviewAttention";
import { AnchorsDueNotice } from "@/components/governance/AnchorsDueNotice";
import { SetupChecklist } from "@/components/integrations/SetupChecklist";
import {
  Badge,
  Button,
  Card,
  ErrorText,
  PageTitle,
} from "@/components/ui";

export default function CommunityDashboard({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { community, role, isAdmin, reload, blocked } = useCommunityGate(slug, {
    require: "community",
  });
  const join = useAsyncAction("Failed to join");
  const treasuries = useTreasuries(community?.id);

  if (blocked) return blocked;

  if (!role) {
    // RLS hides private communities from non-members entirely, so reaching
    // this branch means the community is public — offer to join.
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <div className="flex flex-col items-center gap-3">
          <CommunityAvatar name={community!.name} avatarCid={community!.avatar_cid} size="xl" />
          <h1 className="text-2xl font-semibold">{community!.name}</h1>
        </div>
        {community!.description && (
          <p className="mt-2 text-zinc-400">{community!.description}</p>
        )}
        <p className="mt-4 text-sm text-zinc-500">
          You are not a member of this community yet.
        </p>
        {community!.visibility === Visibility.Public && (
          <Button
            className="mt-4"
            loading={join.busy}
            onClick={() =>
              void join
                .run(() =>
                  apiFetch<JoinCommunityResponse>("/api/community/join", {
                    body: { communityId: community!.id },
                  }),
                )
                // Re-run the community lookup so the new role shows up.
                .then((ok) => ok && reload())
            }
          >
            {join.busy ? "Joining…" : "Join community"}
          </Button>
        )}
        <ErrorText error={join.error} className="mt-2" />
      </div>
    );
  }

  return (
    <div>
      <PageTitle
        action={
          <span className="flex gap-1.5">
            <NetworkBadge network={community!.network} />
            <Badge tone="blue">{role}</Badge>
          </span>
        }
      >
        <span className="inline-flex min-w-0 items-center gap-3">
          <CommunityAvatar name={community!.name} avatarCid={community!.avatar_cid} size="lg" />
          <span className="min-w-0 truncate">{community!.name}</span>
        </span>
      </PageTitle>

      {community!.description && (
        <p className="mb-6 text-sm text-zinc-400">{community!.description}</p>
      )}

      {isAdmin && community && (
        <SetupChecklist communityId={community.id} slug={slug} />
      )}

      {isAdmin && (
        <p className="mb-6 text-sm text-zinc-400">
          <Link
            className="text-indigo-400 hover:underline"
            href={`${routes.members(slug)}#invite-links`}
          >
            Invite members
          </Link>
          {" "}with a shareable link on Members.
        </p>
      )}

      {community && (
        <>
          <OverviewAttention
            slug={slug}
            communityId={community.id}
            treasuries={treasuries.data}
            isAdmin={isAdmin}
          />
          <div className="mb-6">
            <AnchorsDueNotice
              slug={slug}
              communityId={community.id}
              treasuries={treasuries.data}
              isAdmin={isAdmin}
            />
          </div>
        </>
      )}

      <div className="mb-8 grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {COMMUNITY_CARDS.map((card) => (
          <Link key={card.key} href={communityHref(card.key, slug)}>
            <Card className="h-full transition-colors hover:border-indigo-600">
              <h3 className="font-medium">{card.title}</h3>
              <p className="mt-1 text-sm text-zinc-400">{card.blurb}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
