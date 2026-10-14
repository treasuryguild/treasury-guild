"use client";

import { browserClient } from "@/lib/supabase/browser";
import type { ContributorIdentityRow } from "@/lib/db/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";
import { useSession } from "./useSession";

export type MyIdentity = Pick<ContributorIdentityRow, "provider" | "display_name" | "verified_at">;

/** The session wallet's linked Discord / Google accounts (RLS shows it its own rows only). */
export function useMyIdentities(): AsyncData<MyIdentity[]> {
  const { sessionWallet } = useSession();
  return useAsyncData(sessionWallet, async () => {
    const { data, error } = await browserClient()
      .from("contributor_identities")
      .select("provider, display_name, verified_at")
      .eq("wallet_address", sessionWallet);
    if (error) throw new Error(error.message);
    return (data ?? []) as MyIdentity[];
  });
}
