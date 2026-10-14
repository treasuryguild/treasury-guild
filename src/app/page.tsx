"use client";

import Link from "next/link";
import { browserClient } from "@/lib/supabase/browser";
import type { CommunityRow } from "@/lib/db/types";
import { routes } from "@/lib/routes";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useSession } from "@/hooks/useSession";
import { Card, EmptyState, LinkButton, PageTitle } from "@/components/ui";
import { BrandLogo } from "@/components/layout/BrandLogo";

type CommunityCard = Pick<CommunityRow, "id" | "slug" | "name" | "description">;

const LINK_CLASS = "text-indigo-400 underline";

export default function Home() {
  const { sessionWallet, loading } = useSession();
  const { data: communities } = useAsyncData(sessionWallet, async () => {
    const { data } = await browserClient()
      .from("community_members")
      .select("communities(id, slug, name, description)")
      .eq("wallet_address", sessionWallet);
    return (data ?? [])
      .map((r) => r.communities as unknown as CommunityCard | null)
      .filter((c): c is CommunityCard => !!c);
  });

  if (loading) return null;

  if (!sessionWallet) {
    return (
      <div className="glass-panel mx-auto max-w-2xl rounded-3xl px-6 py-14 text-center sm:px-12 sm:py-16">
        <BrandLogo className="mx-auto mb-6 h-20 w-20" />
        <h1 className="text-4xl font-bold">Treasury Guild</h1>
        <p className="mt-4 text-lg text-zinc-400">
          Multisig treasury management for Cardano communities. Sync tasks from
          GitHub or run your own board, pay contributors in batches with
          on-chain payout metadata, and reconcile refunds.
        </p>
        <p className="mt-8 text-sm text-zinc-500">
          Connect a wallet and sign in to get started,{" "}
          <Link href={routes.discover()} className={LINK_CLASS}>
            browse public communities
          </Link>
          , or{" "}
          <Link href={routes.docs()} className={LINK_CLASS}>
            read the docs
          </Link>
          .
        </p>
        <p className="mt-4 text-xs text-zinc-500">
          <Link href={routes.doc("privacy")} className={LINK_CLASS}>
            Privacy policy
          </Link>
        </p>
      </div>
    );
  }

  const list = communities ?? [];

  return (
    <div>
      <PageTitle
        action={
          <div className="flex gap-2">
            <LinkButton href={routes.discover()} variant="secondary">
              Browse communities
            </LinkButton>
            <LinkButton href={routes.newCommunity()}>New community</LinkButton>
          </div>
        }
      >
        Your communities
      </PageTitle>
      {list.length === 0 ? (
        <EmptyState>
          You&apos;re not a member of any community yet.{" "}
          <Link href={routes.discover()} className={LINK_CLASS}>
            Browse public communities
          </Link>
          , link GitHub on the{" "}
          <Link href={routes.welcome()} className={LINK_CLASS}>
            welcome page
          </Link>{" "}
          to join the ones your tasks live in, or create your own.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => (
            <Link key={c.id} href={routes.community(c.slug)}>
              <Card className="h-full transition-colors hover:border-indigo-600">
                <h2 className="font-semibold">{c.name}</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  {c.description ?? `/${c.slug}`}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
