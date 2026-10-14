"use client";

import { browserClient } from "@/lib/supabase/browser";
import type { ContributorProfile } from "@/lib/db/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";
import { useSession } from "./useSession";

/** The session wallet's contributor profile (handle + GitHub login). */
export function useContributorProfile(): AsyncData<ContributorProfile | null> & {
  sessionWallet: string | null;
} {
  const { sessionWallet } = useSession();
  const state = useAsyncData(sessionWallet, async () => {
    const { data } = await browserClient()
      .from("contributors")
      .select("handle, github_username")
      .eq("wallet_address", sessionWallet)
      .maybeSingle();
    return (data as ContributorProfile | null) ?? null;
  });
  return { ...state, sessionWallet };
}
