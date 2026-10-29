"use client";

import { use, useCallback, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/client";
import { formatUnitAmount, unitDisplayFromRegistry } from "@/lib/assetRegistry";
import { describeTemplate, signerCounts } from "@/lib/cardano/spendingPaths";
import { asNetwork } from "@/lib/config";
import { ChainImportStatus, TxState } from "@/lib/constants";
import {
  EXTERNAL_TX_COLUMNS,
  TRANSACTION_SUMMARY_COLUMNS,
  type ExternalTxRow,
  type TransactionSummary,
  type TreasurySummary,
} from "@/lib/db/types";
import { describeExternalTx, recentTreasuryActivity } from "@/lib/externalTx";
import { formatDate, formatLovelace, formatUnits, shortAddress, shortHash, shortUnit } from "@/lib/format";
import { routes } from "@/lib/routes";
import { browserClient } from "@/lib/supabase/browser";
import { useAssetRegistry } from "@/hooks/useAssetRegistry";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useChainImportQueue } from "@/hooks/useChainImportQueue";
import { useChainSync } from "@/hooks/useChainSync";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useGovernanceSettings } from "@/hooks/useProposals";
import { useIntegrationsStatus } from "@/hooks/useIntegrationsStatus";
import { useTreasuries } from "@/hooks/useTreasuries";
import { useWalletAssetsMany } from "@/hooks/useWalletAssets";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorText,
  ExplorerLink,
  NoticeText,
  LinkButton,
  PageTitle,
  SectionTitle,
  TxKindBadge,
  TxStateBadge,
} from "@/components/ui";
import { AnchorsDueNotice } from "@/components/governance/AnchorsDueNotice";
import { IntegrationsNotice } from "@/components/integrations/IntegrationsNotice";
import { IntegrationStatusLink } from "@/components/integrations/IntegrationStatusLink";
import { ChainImportQueue } from "@/components/treasury/ChainImportQueue";
import { ChainSyncStatus } from "@/components/treasury/ChainSyncStatus";
import { TreasuryDetailsModal } from "@/components/treasury/TreasuryDetailsModal";
import { TreasuryLifecycleDialog } from "@/components/treasury/TreasuryLifecycleDialog";

const RECENT_TX_LIMIT = 20;

export default function TreasuryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { community, isAdmin, blocked, reload: reloadCommunity } = useCommunityGate(slug);
  const treasuries = useTreasuries(community?.id);
  const [showArchived, setShowArchived] = useState(false);
  const [managing, setManaging] = useState<TreasurySummary | null>(null);
  const [lifecycleMessage, setLifecycleMessage] = useState("");
  const list = treasuries.data ?? [];
  const hasArchived = list.some((t) => t.archived_at);
  const visible = showArchived ? list : list.filter((t) => !t.archived_at);
  const treasuryIds = visible.map((t) => t.id);
  const allTreasuryIds = list.map((t) => t.id);
  const setPrimary = useAsyncAction("Failed to set primary treasury");

  const txs = useAsyncData(
    treasuryIds.length > 0 ? treasuryIds.join(",") : null,
    async () => {
      const { data } = await browserClient()
        .from("transactions")
        .select(TRANSACTION_SUMMARY_COLUMNS)
        .in("treasury_id", treasuryIds)
        .order("created_at", { ascending: false })
        .limit(RECENT_TX_LIMIT);
      return (data ?? []) as TransactionSummary[];
    },
  );
  // Pending txs are loaded separately so they never fall out of the recent
  // limit(20) window (at most one pending per treasury).
  const pendingTxs = useAsyncData(
    treasuryIds.length > 0 ? `pending:${treasuryIds.join(",")}` : null,
    async () => {
      const { data } = await browserClient()
        .from("transactions")
        .select(TRANSACTION_SUMMARY_COLUMNS)
        .in("treasury_id", treasuryIds)
        .eq("state", TxState.Pending)
        .order("created_at", { ascending: false });
      return (data ?? []) as TransactionSummary[];
    },
  );
  // Outgoing txs found on-chain that the app has no record of (external_txs).
  const externals = useAsyncData(
    treasuryIds.length > 0 ? treasuryIds.join(",") : null,
    async () => {
      const { data } = await browserClient()
        .from("external_txs")
        .select(EXTERNAL_TX_COLUMNS)
        .in("treasury_id", treasuryIds)
        .order("block_time", { ascending: false })
        .limit(RECENT_TX_LIMIT);
      return (data ?? []) as ExternalTxRow[];
    },
  );
  // On-chain payouts and payments the import holds for an admin (not capped
  // by the activity list's limit).
  const importQueue = useChainImportQueue(isAdmin ? allTreasuryIds : []);
  const workgroups = useWorkgroups(isAdmin ? community?.id : null);
  const registry = useAssetRegistry(community?.id);
  // With budget consent on, a spend the app did not build is flagged: it
  // cites no decision and was never checked against the voted budgets.
  const governance = useGovernanceSettings(community?.id);
  const budgetConsent = governance.data?.budget.enabled ?? false;
  // Poll the chain for treasuries not checked in the last two minutes, in the
  // background; the lists reload if anything was polled. Balances are live.
  const reloadTxs = txs.reload;
  const reloadPending = pendingTxs.reload;
  const reloadExternals = externals.reload;
  const reloadQueue = importQueue.reload;
  const reloadActivity = useCallback(() => {
    reloadTxs();
    reloadPending();
    reloadExternals();
    reloadQueue();
  }, [reloadTxs, reloadPending, reloadExternals, reloadQueue]);
  const sync = useChainSync(community?.id, reloadActivity);
  const balances = useWalletAssetsMany(visible.map((t) => t.address));
  // Which treasury's details dialog is open (native script, CBOR, signers).
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const detailsTreasury = list.find((t) => t.id === detailsId) ?? null;
  const integrations = useIntegrationsStatus(isAdmin ? community?.id : null);

  if (blocked) return blocked;

  const display = unitDisplayFromRegistry(registry.data ?? []);
  // Network is per community (every treasury matches it), so explorer links
  // take it from the community row.
  const network = asNetwork(community?.network ?? 0);
  const pending = pendingTxs.data ?? [];
  // Pending rows have their own section; keep them out of the recent feed.
  const activity = recentTreasuryActivity(
    (txs.data ?? []).filter((t) => t.state !== TxState.Pending),
    externals.data ?? [],
    RECENT_TX_LIMIT,
  );
  const treasuryName = (id: string) => list.find((t) => t.id === id)?.name ?? "Unknown wallet";
  const activityLoading = txs.loading || externals.loading;
  const appTxCard = (tx: TransactionSummary) => (
    <Link key={tx.id} href={routes.tx(slug, tx.id)} className="block">
      <Card className="flex flex-col items-start justify-between gap-3 py-4 transition-colors hover:border-indigo-600 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <p className="text-sm">{tx.description ?? "Transaction"}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {visible.length > 1 && <>{treasuryName(tx.treasury_id)} · </>}
            {formatDate(tx.created_at, "datetime")} ·{" "}
            {tx.signed_addresses.length} signature(s)
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <TxKindBadge kind={tx.kind} />
          <TxStateBadge state={tx.state} />
        </span>
      </Card>
    </Link>
  );

  return (
    <div>
      <PageTitle
        action={
          isAdmin ? (
            <div className="flex flex-wrap gap-2">
              <LinkButton href={routes.paymentHistory(slug)} variant="secondary">Payment history</LinkButton>
              <LinkButton href={routes.importTreasury(slug)} variant="secondary">Import treasury</LinkButton>
              <LinkButton href={routes.newTreasury(slug)}>New treasury</LinkButton>
            </div>
          ) : undefined
        }
      >
        Treasury
      </PageTitle>

      {isAdmin && community && (
        <>
          <IntegrationsNotice communityId={community.id} slug={slug} kind="treasury-webhooks" />
          {(() => {
            const payout = integrations.data?.payoutDiscord;
            if (!payout || payout.treasuries.length === 0) return null;
            const connected = payout.treasuries.filter((t) => t.connected).length;
            return (
              <div className="mb-3">
                <IntegrationStatusLink
                  label="Payout Discord"
                  href={`${routes.integrations(slug)}#payout-discord`}
                  status={`${connected}/${payout.treasuries.length} connected`}
                />
              </div>
            );
          })()}
        </>
      )}
      <ErrorText error={setPrimary.error} className="mb-3" />
      <NoticeText className="mb-3">{lifecycleMessage}</NoticeText>
      {hasArchived && (
        <label className="mb-4 flex items-center gap-2 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      )}
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        {visible.map((t) => {
          const balance = balances.data?.[t.address];
          const isPrimary = community?.primary_treasury_id === t.id;
          const archived = !!t.archived_at;
          return (
            <Card key={t.id}>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex min-w-0 flex-wrap items-center gap-2 font-medium">
                    <span className="min-w-0 truncate">{t.name}</span>
                    {isPrimary && <Badge tone="blue">Primary</Badge>}
                    {archived && <Badge>Archived</Badge>}
                  </h3>
                  <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-zinc-500">
                    {shortAddress(t.address)}
                    <CopyButton value={t.address} />
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <Badge>{describeTemplate(t, signerCounts(t.treasury_signers))}</Badge>
                  {t.template === "plain" && t.stake_credential_hash && !archived && (
                    <>
                      <Badge tone="green">SDK</Badge>
                      <LinkButton href={routes.treasuryStaking(slug, t.id)} variant="secondary">
                        Staking
                      </LinkButton>
                      <LinkButton href={routes.treasuryCardanoGov(slug, t.id)} variant="secondary">
                        Cardano gov
                      </LinkButton>
                    </>
                  )}
                  <Button
                    variant="secondary"
                    onClick={() => setDetailsId(t.id)}
                    title="Native script, CBOR, script hash and signers"
                  >
                    Details
                  </Button>
                  {isAdmin && !isPrimary && !archived && (
                    <Button
                      variant="secondary"
                      disabled={setPrimary.busy}
                      title="Base signers of the primary treasury are community admins"
                      onClick={() => void setPrimary.run(async () => {
                        await apiFetch("/api/treasury/primary", {
                          body: { communityId: community!.id, treasuryId: t.id },
                        });
                        reloadCommunity();
                      })}
                    >
                      Set as primary
                    </Button>
                  )}
                  {isAdmin && (
                    <Button variant="secondary" onClick={() => setManaging(t)}>
                      {archived ? "Restore" : "Archive"}
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-4 text-2xl font-semibold">
                {balance ? formatLovelace(balance.lovelace) : "…"}
              </p>
              {balance && balance.tokens.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {balance.tokens.map((tok) => (
                    <span
                      key={tok.unit}
                      className="text-sm text-zinc-400"
                      title={tok.unit}
                    >
                      {formatUnits(
                        tok.quantity,
                        tok.decimals,
                        tok.ticker ?? shortUnit(tok.unit),
                      )}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
        {!treasuries.loading && visible.length === 0 && (
          <EmptyState>
            {list.length > 0
              ? "Archived treasuries are hidden. Show archived to see them."
              : <>No treasury yet. {isAdmin ? "Create a multisig treasury to hold community funds." : ""}</>}
          </EmptyState>
        )}
      </div>

      {managing && (
        <TreasuryLifecycleDialog
          treasury={managing}
          onClose={() => setManaging(null)}
          onChanged={(action) => {
            setManaging(null);
            setLifecycleMessage(action === "archive"
              ? "Treasury archived. Use Show archived to find it."
              : "Treasury restored.");
            treasuries.reload();
          }}
        />
      )}

      {detailsTreasury && community && (
        <TreasuryDetailsModal
          treasuryId={detailsTreasury.id}
          treasuryName={detailsTreasury.name}
          slug={slug}
          communityId={community.id}
          onClose={() => setDetailsId(null)}
        />
      )}

      {isAdmin && community && (
        <ChainImportQueue
          communityId={community.id}
          network={network}
          rows={importQueue.data ?? []}
          workgroups={workgroups.data ?? []}
          treasuryName={list.length > 1 ? treasuryName : null}
          onChanged={reloadActivity}
        />
      )}

      {community && (
        <div className="mb-6">
          <AnchorsDueNotice slug={slug} communityId={community.id} treasuries={list} isAdmin={isAdmin} />
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-8">
          <SectionTitle>Pending</SectionTitle>
          <div className="space-y-3">{pending.map(appTxCard)}</div>
        </div>
      )}

      <SectionTitle>Transactions</SectionTitle>
      <ChainSyncStatus {...sync} className="-mt-2 mb-3" />
      <div className="space-y-3">
        {activity.map((item) => {
          if (item.kind === "app") {
            return appTxCard(item.tx);
          }
          // An outgoing tx seen on-chain without an app record: no signing
          // page to open, so it links to the explorer.
          const tx = item.tx;
          const { title, detail } = describeExternalTx(tx);
          const tokens = Object.entries(tx.assets ?? {});
          return (
            <ExplorerLink
              key={tx.tx_hash}
              network={network}
              target={{ txHash: tx.tx_hash }}
              className="block"
              title="Open in the explorer"
            >
              <Card className="flex flex-col items-start justify-between gap-3 py-4 transition-colors hover:border-indigo-600 sm:flex-row sm:items-center">
                <div className="min-w-0">
                  <p className="text-sm">{title}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {visible.length > 1 && <>{treasuryName(tx.treasury_id)} · </>}
                    {formatDate(tx.block_time, "datetime")} · {detail} ·{" "}
                    <span className="font-mono">{shortHash(tx.tx_hash, 12)}</span>
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">
                    {formatLovelace(tx.amount_lovelace)}
                    {tokens.map(([unit, qty]) => (
                      <span key={unit} title={unit}>
                        {" "}
                        · {formatUnitAmount(unit, qty, display)}
                      </span>
                    ))}
                  </p>
                </div>
                <span className="flex flex-wrap items-center gap-2">
                  {tx.import_status === ChainImportStatus.Blocked && (
                    <Badge tone="yellow">Needs import review</Badge>
                  )}
                  {budgetConsent ? <Badge tone="yellow">Built outside Treasury Guild</Badge> : <Badge>On-chain</Badge>}
                  <TxStateBadge state={TxState.Confirmed} />
                </span>
              </Card>
            </ExplorerLink>
          );
        })}
        {!activityLoading && activity.length === 0 && (
          <EmptyState card={false}>No transactions yet.</EmptyState>
        )}
      </div>
    </div>
  );
}
