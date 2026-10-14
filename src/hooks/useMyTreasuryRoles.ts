"use client";

import { SignerGroup } from "@/lib/constants";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncData } from "./useAsyncData";
import { useSession } from "./useSession";

export interface MyTreasuryRoles {
  /** Treasuries (in this community) the session wallet is a base signer of: the treasury-actor rule. */
  signerTreasuryIds: Set<string>;
  /** Treasuries the session wallet is a recovery signer of (clawback template). */
  recoveryTreasuryIds: Set<string>;
  /** Treasuries the session wallet is the co-signer of. */
  cosignerTreasuryIds: Set<string>;
  /** Workgroups (in this community) the session wallet leads. */
  ledWorkgroupIds: Set<string>;
  loading: boolean;
}

const EMPTY = new Set<string>();

/** Signer + lead roles of the session wallet, scoped to one community. */
export function useMyTreasuryRoles(
  communityId: string | null | undefined,
): MyTreasuryRoles {
  const { sessionWallet } = useSession();
  const key = communityId && sessionWallet ? `${communityId}:${sessionWallet}` : null;
  const { data, loading } = useAsyncData(key, async () => {
    const db = browserClient();
    const [{ data: signerRows }, { data: leadRows }] = await Promise.all([
      db
        .from("treasury_signers")
        .select("treasury_id, signer_group, treasuries!inner(community_id)")
        .eq("wallet_address", sessionWallet)
        .eq("treasuries.community_id", communityId),
      db
        .from("workgroup_leads")
        .select("workgroup_id, workgroups!inner(community_id)")
        .eq("wallet_address", sessionWallet)
        .eq("workgroups.community_id", communityId),
    ]);
    const ofGroup = (group: SignerGroup) =>
      new Set((signerRows ?? []).filter((r) => r.signer_group === group).map((r) => r.treasury_id as string));
    return {
      signerTreasuryIds: ofGroup(SignerGroup.Base),
      recoveryTreasuryIds: ofGroup(SignerGroup.Recovery),
      cosignerTreasuryIds: ofGroup(SignerGroup.Cosigner),
      ledWorkgroupIds: new Set(
        (leadRows ?? []).map((r) => r.workgroup_id as string),
      ),
    };
  });
  return {
    signerTreasuryIds: data?.signerTreasuryIds ?? EMPTY,
    recoveryTreasuryIds: data?.recoveryTreasuryIds ?? EMPTY,
    cosignerTreasuryIds: data?.cosignerTreasuryIds ?? EMPTY,
    ledWorkgroupIds: data?.ledWorkgroupIds ?? EMPTY,
    loading,
  };
}
