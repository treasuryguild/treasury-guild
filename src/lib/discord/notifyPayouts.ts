// Cron stage: announce confirmed payouts to the treasury's Discord channel.
// Runs after pollTreasury has flipped transactions to Confirmed. A tx is
// announced once (transactions.discord_notified_at); transient Discord
// failures leave it unstamped so the next sweep retries. The extras —
// budget balances, treasury balance, exchange rate — are best-effort: if one
// cannot be loaded the message goes out without it.
import "server-only";

import { payoutRowAmounts, unitDisplayLoader, unitTicker, type UnitDisplay } from "@/lib/assetRegistry";
import { ADA_ASSET, LOVELACE } from "@/lib/assets";
import { applyWalletTokenHint } from "@/lib/cardano/assetInfo";
import { fetchWalletAssets } from "@/lib/cardano/walletAssets";
import { asNetwork, explorerAddressUrl, type Network } from "@/lib/config";
import { TxKind, TxState } from "@/lib/constants";
import { loadAssetRegistry, loadMintAssetHints } from "@/lib/db/assets";
import { loadWorkgroupBudgets } from "@/lib/db/budgetDashboard";
import { check, optionalRelation, rows, serviceClient } from "@/lib/db/client";
import { appUrl } from "@/lib/env.server";
import { errorMessage } from "@/lib/errors";
import { shortUnit } from "@/lib/format";
import { fetchExchangeRate } from "@/lib/rates/coingecko";
import { routes } from "@/lib/routes";
import {
  AVATAR_PATH,
  buildPayoutEmbed,
  type BudgetBalanceLine,
  type ExchangeRate,
  type PayoutAmount,
  type PayoutMessageTask,
} from "./payoutMessage";
import { DiscordWebhookError, postDiscordWebhook, type FetchLike } from "./webhook";

const BATCH = 20;

interface WebhookEmbed {
  url: string;
}

interface CommunityEmbed {
  slug: string;
  name: string;
  discord_rate_coin: string | null;
  discord_rate_currency: string;
}

interface PendingTx {
  id: string;
  tx_hash: string | null;
  treasury_id: string;
  treasuries: {
    name: string;
    address: string;
    network: number;
    community_id: string;
    // One-to-one (PK = FK) so PostgREST returns an object; typed loosely in
    // case the client ever inlines it as a one-element array.
    treasury_discord_webhooks: WebhookEmbed | WebhookEmbed[];
    communities: CommunityEmbed | CommunityEmbed[];
  };
}

const PENDING_TX_COLUMNS =
  "id, tx_hash, treasury_id, treasuries!inner(name, address, network, community_id, treasury_discord_webhooks!inner(url), communities!inner(slug, name, discord_rate_coin, discord_rate_currency))";

interface PayoutLine {
  task_id: string;
  contributor_wallet: string;
  unit: string;
  amount: string;
  tasks: { workgroup_id: string; workgroups: { name: string } };
}

const PAYOUT_LINE_COLUMNS =
  "task_id, contributor_wallet, unit, amount, tasks!inner(workgroup_id, workgroups!inner(name))";


export type PayoutTaskWithWorkgroup = PayoutMessageTask & { workgroupId: string };

/**
 * Payout rows are per (task, wallet, unit). Every assignee of a task gets
 * identical amounts, so amounts come from one wallet's rows and the
 * recipients are the distinct wallets — same grouping as the GitHub write-back.
 */
export function groupPayoutLines(lines: PayoutLine[], display: UnitDisplay): PayoutTaskWithWorkgroup[] {
  const byTask = new Map<string, PayoutLine[]>();
  for (const line of lines) {
    const list = byTask.get(line.task_id);
    if (list) list.push(line);
    else byTask.set(line.task_id, [line]);
  }
  const tasks: PayoutTaskWithWorkgroup[] = [];
  for (const group of byTask.values()) {
    const first = group[0]!;
    const wallets = [...new Set(group.map((p) => p.contributor_wallet))];
    const firstWalletRows = group.filter((p) => p.contributor_wallet === first.contributor_wallet);
    tasks.push({
      workgroupId: first.tasks.workgroup_id,
      workgroupName: first.tasks.workgroups.name,
      amounts: payoutRowAmounts(firstWalletRows, display),
      recipientWallets: wallets,
    });
  }
  return tasks;
}

/** Budget rows for the message: the dashboard's summaries, narrowed to what the embed shows. */
export function budgetLinesFrom(
  summaries: { ownerName: string; periodLabel: string; assetLabel: string; decimals: number; amount: string; spent: string }[],
): BudgetBalanceLine[] {
  return summaries.map((b) => ({
    workgroupName: b.ownerName,
    periodLabel: b.periodLabel,
    ticker: b.assetLabel,
    decimals: b.decimals,
    allocated: BigInt(b.amount),
    spent: BigInt(b.spent),
  }));
}

async function loadBudgets(communityId: string, workgroupIds: string[], now: Date): Promise<BudgetBalanceLine[]> {
  try {
    return budgetLinesFrom(await loadWorkgroupBudgets(communityId, workgroupIds, now));
  } catch (err) {
    console.error(`discord notify: budgets for ${communityId} failed`, err);
    return [];
  }
}

/** Treasury balance after the payout: ADA first, then tokens by known ticker, mint hint or hex. */
async function loadBalance(
  network: Network,
  address: string,
  display: UnitDisplay,
): Promise<{ url: string; amounts: PayoutAmount[] } | null> {
  try {
    const assets = await fetchWalletAssets(network, address);
    const hints = await loadMintAssetHints(
      assets.tokens.filter((t) => t.source === "ascii" || t.source === "none").map((t) => t.unit),
    );
    const amounts: PayoutAmount[] = [
      { ticker: unitTicker(LOVELACE, display), decimals: ADA_ASSET.decimals, quantity: assets.lovelace },
      ...assets.tokens.map((raw) => {
        const token = applyWalletTokenHint(raw, hints.get(raw.unit));
        const known = display.get(token.unit);
        return {
          ticker: known?.ticker ?? token.ticker ?? shortUnit(token.unit),
          decimals: known?.decimals ?? token.decimals,
          quantity: token.quantity,
        };
      }),
    ];
    return { url: explorerAddressUrl(network, address), amounts };
  } catch (err) {
    console.error(`discord notify: balance for ${address} failed`, err);
    return null;
  }
}

async function loadRate(community: CommunityEmbed, fetchImpl?: FetchLike): Promise<ExchangeRate | null> {
  if (!community.discord_rate_coin) return null;
  return fetchExchangeRate(community.discord_rate_coin, community.discord_rate_currency, fetchImpl);
}

export interface NotifyResult {
  posted: number;
  /** Transient failures, retried next sweep. */
  failed: number;
  /** Webhooks that answered permanently (deleted, rejected): tx stamped, error recorded. */
  dead: number;
}

export interface NotifyOptions {
  /** Used for both Discord and CoinGecko (tests). */
  fetchImpl?: FetchLike;
  now?: Date;
}

export async function notifyConfirmedPayouts(options: NotifyOptions = {}): Promise<NotifyResult> {
  const db = serviceClient();
  const now = options.now ?? new Date();
  const pending = rows<PendingTx>(
    await db
      .from("transactions")
      .select(PENDING_TX_COLUMNS)
      .eq("state", TxState.Confirmed)
      .eq("kind", TxKind.Payout)
      .is("discord_notified_at", null)
      .limit(BATCH),
    "load payouts to announce",
  );

  const unitDisplay = unitDisplayLoader(loadAssetRegistry);

  const result: NotifyResult = { posted: 0, failed: 0, dead: 0 };
  for (const tx of pending) {
    const treasury = tx.treasuries;
    const webhook = optionalRelation(treasury.treasury_discord_webhooks);
    const community = optionalRelation(treasury.communities);
    if (!tx.tx_hash || !webhook || !community) continue;

    const network = asNetwork(treasury.network);
    const display = await unitDisplay(treasury.community_id);
    const lines = rows<PayoutLine>(
      await db.from("payouts").select(PAYOUT_LINE_COLUMNS).eq("transaction_id", tx.id),
      "load payout lines",
    );
    const tasks = groupPayoutLines(lines, display);
    const workgroupIds = [...new Set(tasks.map((t) => t.workgroupId))];

    const [budgets, balance, rate] = await Promise.all([
      loadBudgets(treasury.community_id, workgroupIds, now),
      loadBalance(network, treasury.address, display),
      loadRate(community, options.fetchImpl),
    ]);

    const base = appUrl();
    const payload = buildPayoutEmbed({
      community: {
        name: community.name,
        url: `${base}${routes.community(community.slug)}`,
        iconUrl: `${base}${AVATAR_PATH}`,
      },
      treasuryName: treasury.name,
      txHash: tx.tx_hash,
      network,
      links: {
        transaction: `${base}${routes.tx(community.slug, tx.id)}`,
        dashboard: `${base}${routes.dashboard(community.slug)}`,
      },
      tasks,
      budgets,
      balance,
      rate,
      at: now,
    });

    try {
      await postDiscordWebhook(webhook.url, payload, options.fetchImpl);
    } catch (err) {
      const permanent = err instanceof DiscordWebhookError && err.permanent;
      console.error(`discord notify for tx ${tx.id} failed`, err);
      if (!permanent) {
        result.failed += 1;
        continue;
      }
      // Stop retrying this tx; leave the reason where the admin can see it.
      check(
        await db
          .from("treasury_discord_webhooks")
          .update({ last_error: errorMessage(err) })
          .eq("treasury_id", tx.treasury_id),
        "record webhook error",
      );
      check(
        await db.from("transactions").update({ discord_notified_at: new Date().toISOString() }).eq("id", tx.id),
        "stamp discord notification",
      );
      result.dead += 1;
      continue;
    }

    const stamp = new Date().toISOString();
    check(
      await db.from("transactions").update({ discord_notified_at: stamp }).eq("id", tx.id),
      "stamp discord notification",
    );
    check(
      await db
        .from("treasury_discord_webhooks")
        .update({ last_posted_at: stamp, last_error: null })
        .eq("treasury_id", tx.treasury_id),
      "record webhook post",
    );
    result.posted += 1;
  }
  return result;
}
