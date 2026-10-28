// The reconcile sweep: poll every treasury address for confirmed payouts and
// incoming funds, retry GitHub write-backs, announce confirmed payouts on
// Discord, move proposals along. Run by the Netlify schedule through
// /api/cron/reconcile and by hand from the /dev tools page (the schedule
// never reaches localhost).
import "server-only";

import { payoutRowAmounts, unitDisplayLoader } from "@/lib/assetRegistry";
import { addressTail } from "@/lib/cardano/metadata";
import { asNetwork } from "@/lib/config";
import { PayoutStatus, TaskSource } from "@/lib/constants";
import { check, maybe, rows, serviceClient } from "@/lib/db/client";
import { loadAssetRegistry } from "@/lib/db/assets";
import { cosignReadyTransactions, type CosignSweepResult } from "@/lib/cosigner/sign";
import { purgeExpiredNonces } from "@/lib/db/auth";
import { purgeCommunityInvites } from "@/lib/db/invites";
import { purgeOAuth } from "@/lib/db/oauth";
import { purgeRateLimits } from "@/lib/db/rateLimit";
import { releaseOrphanedQueuedTasks } from "@/lib/db/tasks";
import { notifyAnchorsDue, type AnchorNotifyResult } from "@/lib/discord/notifyAnchorsDue";
import { notifyConfirmedPayouts } from "@/lib/discord/notifyPayouts";
import { notifyProposalMilestones, type ProposalNotifyResult } from "@/lib/discord/notifyProposals";
import { writeBackPayment } from "@/lib/github/writeback";
import { notifyOutsideSpends, type OutsideSpendNotifyResult } from "@/lib/discord/notifyOutsideSpends";
import { advanceDueProposals, type AdvanceSweepResult } from "@/lib/governance/advance";
import { freezeMissingTallyDocuments, type FreezeSweepResult } from "@/lib/governance/freeze";
import { publishTallyDocuments, type PublishSweepResult } from "@/lib/governance/publish";
import { syncTreasury, type TreasurySyncResult } from "@/lib/reconciliation/syncTreasury";

// A type alias (not an interface) so the route wrapper's JSON type accepts it.
export type ReconcileSweepResult = {
  /** Per treasury id; a treasury whose poll threw is absent (logged). */
  results: Record<string, TreasurySyncResult>;
  /** GitHub issues that received a payment comment this run. */
  writtenBack: number;
  /** GitHub project items now sitting in their repo's Paid status. */
  statusMoved: number;
  /** Discord messages posted this run. */
  discordPosted: number;
  /** Proposals moved along (voting opened, result recorded, carried out) and those that failed. */
  proposals: AdvanceSweepResult;
  /** Proposal milestones posted to communities' Discord webhooks. */
  proposalAnnouncements: ProposalNotifyResult;
  /** Tally documents frozen for final proposals that lacked one. */
  tallyDocuments: FreezeSweepResult;
  /** Frozen documents published to (or checked in) the communities' chosen stores. */
  documentCopies: PublishSweepResult;
  /** Stale / copy-grace on-chain anchor reminders posted to governance channels. */
  anchorAlerts: AnchorNotifyResult;
  /** Spends built outside the app announced to governance channels. */
  outsideSpends: OutsideSpendNotifyResult;
  /** Co-signed transactions the app-held co-signer signed or refused this run. */
  cosigned: CosignSweepResult;
  /** Queued tasks with no live payout put back to payable. */
  releasedTasks: number;
};

interface PendingWriteback {
  id: string;
  transaction_id: string;
  task_id: string;
  unit: string;
  amount: string;
  contributor_wallet: string;
  tasks: {
    gh_issue_number: number | null;
    gh_repo_id: number | null;
    gh_project_item_node_id: string | null;
  };
  transactions: {
    tx_hash: string | null;
    treasuries: { network: number; community_id: string };
  };
}

// payouts.contributor_wallet has no FK to contributors (a paid wallet need not
// be a contributor), so handles cannot be embedded: they are looked up below.
const PENDING_WRITEBACK_COLUMNS =
  "id, transaction_id, task_id, unit, amount, contributor_wallet, tasks!inner(source, gh_issue_number, gh_repo_id, gh_project_item_node_id), transactions!inner(tx_hash, treasuries!inner(network, community_id))";

export async function runReconcileSweep(): Promise<ReconcileSweepResult> {
  const db = serviceClient();

  // Scheduled workgroup wallet changes land on their period start; the
  // sweep is what makes them current (see migration 0035).
  const applied = await db.rpc("apply_workgroup_treasury_assignments");
  if (applied.error) console.error("apply_workgroup_treasury_assignments failed", applied.error);

  // Proposals whose discussion or voting period ended: open voting, record
  // the result, carry out the passed ones (budget consent).
  let proposals: AdvanceSweepResult = { advanced: 0, failed: 0 };
  try {
    proposals = await advanceDueProposals(new Date());
  } catch (err) {
    console.error("advanceDueProposals failed", err);
  }
  let proposalAnnouncements: ProposalNotifyResult = { posted: 0, failed: 0, dead: 0 };
  try {
    proposalAnnouncements = await notifyProposalMilestones(new Date());
  } catch (err) {
    console.error("notifyProposalMilestones failed", err);
  }
  // Final proposals get their frozen tally document (a close that crashed
  // before freezing, or the backlog at launch), then the documents go to the
  // store each community chose.
  let tallyDocuments: FreezeSweepResult = { frozen: 0, failed: 0 };
  try {
    tallyDocuments = await freezeMissingTallyDocuments();
  } catch (err) {
    console.error("freezeMissingTallyDocuments failed", err);
  }
  let documentCopies: PublishSweepResult = { published: 0, republished: 0, failed: 0, checked: 0 };
  try {
    documentCopies = await publishTallyDocuments(new Date());
  } catch (err) {
    console.error("publishTallyDocuments failed", err);
  }
  // After freeze/publish so closed and copy-grace state is current: remind
  // when anchors have sat due, and before a closed anchor goes without its locator.
  let anchorAlerts: AnchorNotifyResult = { posted: 0, skipped: 0, failed: 0 };
  try {
    anchorAlerts = await notifyAnchorsDue(new Date());
  } catch (err) {
    console.error("notifyAnchorsDue failed", err);
  }

  const treasuries = rows<{ id: string; community_id: string; address: string; network: number }>(
    await db.from("treasuries").select("id, community_id, address, network"),
    "load treasuries",
  );

  const results: ReconcileSweepResult["results"] = {};
  for (const treasury of treasuries) {
    try {
      results[treasury.id] = await syncTreasury(treasury);
    } catch (err) {
      console.error(`syncTreasury ${treasury.id} failed`, err);
    }
  }

  // Outgoing transactions the app did not build, once the chain import has
  // had its look at them: announced to the governance channel of a community
  // that decides budgets by vote.
  let outsideSpends: OutsideSpendNotifyResult = { posted: 0, skipped: 0, failed: 0 };
  try {
    outsideSpends = await notifyOutsideSpends();
  } catch (err) {
    console.error("notifyOutsideSpends failed", err);
  }

  // Retry GitHub write-backs for confirmed payouts on github tasks.
  // Payout rows are per (task, wallet, unit) — group per task so each issue
  // gets one comment listing every asset paid and every assignee paid.
  const pendingWritebacks = rows<PendingWriteback>(
    await db
      .from("payouts")
      .select(PENDING_WRITEBACK_COLUMNS)
      .eq("status", PayoutStatus.Confirmed)
      .eq("tasks.source", TaskSource.Github)
      .limit(50),
    "load pending write-backs",
  );

  const wallets = [...new Set(pendingWritebacks.map((p) => p.contributor_wallet))];
  const handles = new Map(
    (wallets.length > 0
      ? rows<{ wallet_address: string; handle: string | null }>(
          await db
            .from("contributors")
            .select("wallet_address, handle")
            .in("wallet_address", wallets),
          "load recipient handles",
        )
      : []
    ).map((c) => [c.wallet_address, c.handle]),
  );

  const groups = new Map<string, PendingWriteback[]>();
  for (const payout of pendingWritebacks) {
    const key = `${payout.transaction_id}:${payout.task_id}`;
    const group = groups.get(key);
    if (group) group.push(payout);
    else groups.set(key, [payout]);
  }

  // unit -> {ticker, decimals} per community, loaded lazily
  const unitDisplay = unitDisplayLoader(loadAssetRegistry);

  let writtenBack = 0;
  let statusMoved = 0;
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const { tasks: task, transactions: tx } = first;
    if (!task.gh_repo_id || !task.gh_issue_number || !tx.tx_hash) continue;

    const repo = maybe<{ installation_id: number; full_name: string; paid_status: string }>(
      await db
        .from("github_repos")
        .select("installation_id, full_name, paid_status")
        .eq("id", task.gh_repo_id)
        .maybeSingle(),
      "load repo",
    );
    if (!repo) continue;

    // Every assignee receives identical amounts, so the amounts come from one
    // wallet's rows and the recipients are the distinct wallets.
    const byWallet = new Map<string, PendingWriteback[]>();
    for (const p of group) {
      const list = byWallet.get(p.contributor_wallet);
      if (list) list.push(p);
      else byWallet.set(p.contributor_wallet, [p]);
    }
    const recipientLabels = [...byWallet.keys()].map(
      (walletAddr) => handles.get(walletAddr) ?? `…${addressTail(walletAddr)}`,
    );
    const firstWalletRows = byWallet.get(first.contributor_wallet) ?? group;

    const display = await unitDisplay(tx.treasuries.community_id);
    // Move the issue to the repo's Paid column too, when configured and the
    // task knows which project item it was imported from.
    const paidStatus = repo.paid_status.trim();
    const projectItem =
      paidStatus && task.gh_project_item_node_id
        ? { itemNodeId: task.gh_project_item_node_id, status: paidStatus }
        : null;
    try {
      const { movedToStatus } = await writeBackPayment({
        installationId: repo.installation_id,
        repoFullName: repo.full_name,
        issueNumber: task.gh_issue_number,
        amounts: payoutRowAmounts(firstWalletRows, display),
        recipientLabels,
        txHash: tx.tx_hash,
        network: asNetwork(tx.treasuries.network),
        projectItem,
      });
      if (movedToStatus) {
        // Mirror the new column right away; the sync would only catch up on
        // the next projects_v2_item webhook or hourly sweep.
        check(
          await db.from("tasks").update({ gh_status: movedToStatus }).eq("id", first.task_id),
          "mirror paid status",
        );
        statusMoved += 1;
      }
      check(
        await db
          .from("payouts")
          .update({ status: PayoutStatus.WrittenBack })
          .in(
            "id",
            group.map((p) => p.id),
          ),
        "mark written back",
      );
      writtenBack += 1;
    } catch (err) {
      console.error(`write-back for payout ${first.id} failed`, err);
    }
  }

  // Announce confirmed payouts to treasuries with a Discord webhook.
  let discordPosted = 0;
  try {
    discordPosted = (await notifyConfirmedPayouts()).posted;
  } catch (err) {
    console.error("discord notifications failed", err);
  }

  // Rate-limit counters are kept a day at most (privacy policy).
  try {
    await purgeRateLimits(new Date());
  } catch (err) {
    console.error("rate limit purge failed", err);
  }

  // Community invite links that expired or were revoked long ago.
  try {
    await purgeCommunityInvites(new Date());
  } catch (err) {
    console.error("community invite purge failed", err);
  }

  // Expired OAuth codes and refresh tokens, and AI-client registrations nobody
  // approved (privacy policy).
  try {
    await purgeOAuth(new Date());
  } catch (err) {
    console.error("oauth purge failed", err);
  }

  // Login challenges nobody signed in time.
  try {
    await purgeExpiredNonces(new Date());
  } catch (err) {
    console.error("login challenge purge failed", err);
  }

  // Tasks left queued with no live payout (a release that failed before
  // rejecting and deleting became one database step) go back to payable.
  let releasedTasks = 0;
  try {
    releasedTasks = await releaseOrphanedQueuedTasks();
    if (releasedTasks > 0) console.warn(`released ${releasedTasks} queued task(s) with no live payout`);
  } catch (err) {
    console.error("orphaned task release failed", err);
  }

  // Co-signed transactions whose base signers are done and whose app-held
  // co-signer has not signed: run the check again (a refusal may have been
  // lifted; a crash after the last signature is repaired).
  let cosigned: CosignSweepResult = { signed: 0, refused: 0 };
  try {
    cosigned = await cosignReadyTransactions();
  } catch (err) {
    console.error("cosignReadyTransactions failed", err);
  }

  return {
    results, writtenBack, statusMoved, discordPosted, proposals, proposalAnnouncements, tallyDocuments, documentCopies,
    anchorAlerts, outsideSpends, cosigned, releasedTasks,
  };
}
