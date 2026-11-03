"use client";

// Compact "needs attention" strip for the community overview: pending
// signatures for the session wallet, payable tasks, and (admins) blocked
// chain imports. Anchors due stay in AnchorsDueNotice beside this strip.
import Link from "next/link";
import { ChainImportStatus, TxState, type SignerGroup } from "@/lib/constants";
import {
  TRANSACTION_SUMMARY_COLUMNS,
  type TransactionSummary,
  type TreasurySummary,
} from "@/lib/db/types";
import { plural } from "@/lib/format";
import { txsWaitingOnMe } from "@/lib/overview/waitingOnMe";
import { routes } from "@/lib/routes";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useChainImportQueue } from "@/hooks/useChainImportQueue";
import { usePayableTasks } from "@/hooks/usePayableTasks";
import { useSession } from "@/hooks/useSession";
import { Card } from "@/components/ui";

const PENDING_COLUMNS = `${TRANSACTION_SUMMARY_COLUMNS}, rejected_addresses`;

type PendingRow = TransactionSummary & { rejected_addresses: string[] };

type SignerRow = {
  treasury_id: string;
  wallet_address: string;
  signer_group: SignerGroup;
};

export function OverviewAttention({
  slug,
  communityId,
  treasuries,
  isAdmin,
}: {
  slug: string;
  communityId: string;
  treasuries: readonly TreasurySummary[] | null;
  isAdmin: boolean;
}) {
  const { sessionWallet } = useSession();
  const treasuryIds = (treasuries ?? []).map((t) => t.id);
  const payable = usePayableTasks(communityId);
  const importQueue = useChainImportQueue(isAdmin ? treasuryIds : []);

  const pending = useAsyncData(
    treasuryIds.length > 0 ? `overview-pending:${treasuryIds.join(",")}` : null,
    async () => {
      const { data, error } = await browserClient()
        .from("transactions")
        .select(PENDING_COLUMNS)
        .in("treasury_id", treasuryIds)
        .eq("state", TxState.Pending)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as PendingRow[];
    },
  );

  const signers = useAsyncData(
    treasuryIds.length > 0 ? `overview-signers:${treasuryIds.join(",")}` : null,
    async () => {
      const { data, error } = await browserClient()
        .from("treasury_signers")
        .select("treasury_id, wallet_address, signer_group")
        .in("treasury_id", treasuryIds);
      if (error) throw new Error(error.message);
      return (data ?? []) as SignerRow[];
    },
  );

  const waiting =
    sessionWallet && pending.data && signers.data && treasuries
      ? txsWaitingOnMe(pending.data, treasuries, signers.data, sessionWallet)
      : [];
  const payableCount = payable.data?.length ?? 0;
  const blockedCount = (importQueue.data ?? []).filter(
    (r) => r.import_status === ChainImportStatus.Blocked,
  ).length;

  const items: { href: string; text: string }[] = [];
  const firstWaiting = waiting[0];
  if (waiting.length === 1 && firstWaiting) {
    items.push({
      href: routes.tx(slug, firstWaiting.id),
      text: "1 transaction is waiting for your signature",
    });
  } else if (waiting.length > 1) {
    items.push({
      href: routes.treasury(slug),
      text: `${plural(waiting.length, "transaction")} are waiting for your signature`,
    });
  }
  if (payableCount > 0) {
    items.push({
      href: routes.payday(slug),
      text: `${plural(payableCount, "payable task")} ready for Payday`,
    });
  }
  if (isAdmin && blockedCount > 0) {
    items.push({
      href: routes.treasury(slug),
      text: `${plural(blockedCount, "on-chain payment")} need import on Treasury`,
    });
  }

  if (items.length === 0) return null;

  return (
    <Card className="mb-6">
      <h3 className="mb-2 text-sm font-medium">Needs attention</h3>
      <ul className="space-y-1.5 text-sm">
        {items.map((item) => (
          <li key={item.href + item.text}>
            <Link className="text-indigo-400 hover:underline" href={item.href}>
              {item.text}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
