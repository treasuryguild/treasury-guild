"use client";

// Community discovery grid. RLS does the filtering: the communities select
// returns public rows plus the rows the session wallet is a member of (anon
// sees just the public ones), so "available to you" needs no server call.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type { JoinCommunityResponse } from "@/lib/api/types";
import { asNetwork, networkName } from "@/lib/config";
import { Visibility } from "@/lib/constants";
import { COMMUNITY_COLUMNS, type CommunityRow } from "@/lib/db/types";
import { sortByWalletNetwork } from "@/lib/networkGate";
import { routes } from "@/lib/routes";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useSession } from "@/hooks/useSession";
import { NetworkBadge } from "./NetworkNotice";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  LinkButton,
} from "@/components/ui";

export function CommunityDirectory() {
  const { sessionWallet, walletNetwork, loading: sessionLoading } = useSession();
  const router = useRouter();
  const { data, loading } = useAsyncData(
    sessionLoading ? null : `directory:${sessionWallet ?? ""}`,
    async () => {
      const db = browserClient();
      const { data: cs } = await db
        .from("communities")
        .select(COMMUNITY_COLUMNS)
        .order("name");
      let memberOf = new Set<string>();
      if (sessionWallet) {
        const { data: ms } = await db
          .from("community_members")
          .select("community_id")
          .eq("wallet_address", sessionWallet);
        memberOf = new Set((ms ?? []).map((m) => m.community_id as string));
      }
      return { communities: (cs ?? []) as CommunityRow[], memberOf };
    },
  );
  const join = useAsyncAction("Failed to join");
  const joining = join.busy;

  async function joinCommunity(c: CommunityRow) {
    const result = await join.run(() =>
      apiFetch<JoinCommunityResponse>("/api/community/join", {
        body: { communityId: c.id },
      }),
    );
    if (result) router.push(routes.community(result.slug));
  }

  if (loading || !data) return null;

  if (data.communities.length === 0) {
    return (
      <EmptyState>
        No communities to show yet. Public communities appear here — or{" "}
        <Link href={routes.newCommunity()} className="text-indigo-400 underline">
          create your own
        </Link>
        .
      </EmptyState>
    );
  }

  // The wallet's network comes first; the rest stay listed but dimmed, with
  // the reason, so a tester never wonders why a community "doesn't work".
  const ordered = sortByWalletNetwork(data.communities, walletNetwork);

  return (
    <div>
      <ErrorText error={join.error} className="mb-3" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((c) => {
          const isMember = data.memberOf.has(c.id);
          const otherNetwork = walletNetwork !== null && c.network !== walletNetwork;
          return (
            <Card
              key={c.id}
              className={`flex h-full flex-col ${otherNetwork ? "opacity-60" : ""}`}
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <h2 className="min-w-0 font-semibold">{c.name}</h2>
                <span className="flex shrink-0 gap-1.5">
                  <NetworkBadge network={c.network} />
                  {c.visibility === Visibility.Private && <Badge>private</Badge>}
                </span>
              </div>
              <p className="mt-1 flex-1 text-sm text-zinc-400">
                {c.description ?? `/${c.slug}`}
              </p>
              {otherNetwork && (
                <p className="mt-2 text-xs text-amber-500">
                  Runs on {networkName(asNetwork(c.network))}; switch your wallet
                  to a {networkName(asNetwork(c.network))} account to take part.
                </p>
              )}
              <div className="mt-4">
                {isMember ? (
                  <LinkButton href={routes.community(c.slug)} variant="secondary">
                    Open
                  </LinkButton>
                ) : c.visibility === Visibility.Public ? (
                  sessionWallet ? (
                    <Button
                      disabled={joining}
                      onClick={() => void joinCommunity(c)}
                    >
                      {joining ? "Joining…" : "Join"}
                    </Button>
                  ) : (
                    <p className="text-sm text-zinc-500">Sign in to join</p>
                  )
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
