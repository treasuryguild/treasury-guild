// Service-role reads and writes behind the Payments page's build route.
import "server-only";

import { contributorLabel } from "@/lib/assignees";
import { check, optionalRelation, rows, serviceClient } from "./client";
import { MEMBER_WITH_CONTRIBUTOR_COLUMNS, type MemberWithContributor } from "./types";

export interface SiblingTreasury {
  id: string;
  name: string;
  address: string;
  archived_at: string | null;
}

/** The community's other treasuries: an output to one of them is a transfer. */
export async function loadSiblingTreasuries(
  communityId: string,
  exceptTreasuryId: string,
): Promise<SiblingTreasury[]> {
  return rows<SiblingTreasury>(
    await serviceClient()
      .from("treasuries")
      .select("id, name, address, archived_at")
      .eq("community_id", communityId)
      .neq("id", exceptTreasuryId),
    "load sibling treasuries",
  );
}

/** Display labels of the community members among `wallets` (handle, GitHub login, or null). */
export async function loadMemberLabels(
  communityId: string,
  wallets: readonly string[],
): Promise<Map<string, string | null>> {
  const labels = new Map<string, string | null>();
  const distinct = [...new Set(wallets)];
  if (distinct.length === 0) return labels;
  const members = rows<MemberWithContributor>(
    await serviceClient()
      .from("community_members")
      .select(MEMBER_WITH_CONTRIBUTOR_COLUMNS)
      .eq("community_id", communityId)
      .in("wallet_address", distinct),
    "load payment recipients",
  );
  for (const member of members) {
    const profile = optionalRelation(member.contributors);
    const label = profile?.handle || profile?.github_username
      ? contributorLabel({
        wallet: member.wallet_address,
        handle: profile?.handle ?? null,
        githubUsername: profile?.github_username ?? null,
      })
      : null;
    labels.set(member.wallet_address, label);
  }
  return labels;
}

export interface NewPaymentRow {
  transaction_id: string;
  community_id: string;
  treasury_id: string;
  recipient_wallet: string;
  recipient_treasury_id: string | null;
  label: string | null;
  unit: string;
  amount: string;
  /** "YYYY-MM-DD" for spend, null for a transfer. */
  budget_month: string | null;
}

export async function insertPayments(payments: NewPaymentRow[]): Promise<void> {
  if (payments.length === 0) return;
  check(await serviceClient().from("payments").insert(payments), "insert payments");
}
