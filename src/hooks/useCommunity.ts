"use client";

import { browserClient } from "@/lib/supabase/browser";
import { COMMUNITY_COLUMNS, type CommunityRow } from "@/lib/db/types";
import { isAdminRole } from "@/lib/roles";
import { useAsyncData } from "./useAsyncData";
import { useSession } from "./useSession";

export type Community = CommunityRow;

export interface CommunityState {
  community: Community | null;
  /** Caller's role in the community, null when not a member. */
  role: string | null;
  isAdmin: boolean;
  sessionWallet: string | null;
  loading: boolean;
  error: string | null;
  /** Re-run the lookup (e.g. after joining). */
  reload: () => void;
}

/** The community at `slug` (RLS-visible) and the session wallet's role in it. */
export function useCommunity(slug: string): CommunityState {
  const { sessionWallet, loading: sessionLoading } = useSession();
  const key = sessionLoading ? null : `${slug}:${sessionWallet ?? ""}`;

  const { data, loading, error, reload } = useAsyncData(key, async () => {
    const db = browserClient();
    const { data: community } = await db
      .from("communities")
      .select(COMMUNITY_COLUMNS)
      .eq("slug", slug)
      .maybeSingle();
    let role: string | null = null;
    if (community && sessionWallet) {
      const { data: member } = await db
        .from("community_members")
        .select("role")
        .eq("community_id", community.id)
        .eq("wallet_address", sessionWallet)
        .maybeSingle();
      role = member?.role ?? null;
    }
    return { community: (community as CommunityRow | null) ?? null, role };
  });

  return {
    community: data?.community ?? null,
    role: data?.role ?? null,
    isAdmin: isAdminRole(data?.role),
    sessionWallet,
    loading: sessionLoading || loading,
    error,
    reload,
  };
}
