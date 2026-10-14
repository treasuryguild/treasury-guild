// The Discord message posted when a payout is confirmed on-chain. Pure and
// client-safe: given the payout's per-workgroup amounts, the workgroups'
// budget balances, the treasury balance and an exchange rate, produce the
// webhook payload. Amount rendering is exact (formatUnits — never float math
// on on-chain integers; the fiat rate is the only float, and it is display-only).

import { explorerTxUrl, type Network } from "@/lib/config";
import { formatUnits, shortHash, truncate } from "@/lib/format";

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedAuthor {
  name: string;
  url?: string;
  icon_url?: string;
}

export interface DiscordEmbedFooter {
  text: string;
  icon_url?: string;
}

export interface DiscordEmbed {
  title: string;
  url?: string;
  description?: string;
  color?: number;
  author?: DiscordEmbedAuthor;
  fields?: DiscordEmbedField[];
  footer?: DiscordEmbedFooter;
  timestamp?: string;
}

export interface DiscordWebhookPayload {
  username: string;
  embeds: DiscordEmbed[];
}

export interface PayoutAmount {
  ticker: string;
  decimals: number;
  quantity: bigint;
}

/** One paid task: every recipient wallet receives `amounts` in full. */
export interface PayoutMessageTask {
  workgroupName: string;
  amounts: PayoutAmount[];
  recipientWallets: string[];
}

/** A workgroup's budget for its current period, per asset, after this payout. */
export interface BudgetBalanceLine {
  workgroupName: string;
  /** "September 2026" or "Q3 2026". */
  periodLabel: string;
  ticker: string;
  decimals: number;
  allocated: bigint;
  spent: bigint;
}

/** Fiat price of one coin, from the community's chosen source. */
export interface ExchangeRate {
  price: number;
  /** ISO-ish code as configured, e.g. "usd". */
  currency: string;
  /** The coin's ticker, e.g. "ADA". */
  symbol: string;
}

export interface PayoutMessageInput {
  community: { name: string; url?: string; iconUrl?: string };
  treasuryName: string;
  txHash: string;
  network: Network;
  /** In-app links shown under the title. */
  links?: { transaction?: string; dashboard?: string };
  tasks: PayoutMessageTask[];
  /** Budgets of the workgroups paid; a workgroup with none shows "no budget". */
  budgets: BudgetBalanceLine[];
  /** Treasury balance after the payout, with an explorer link. */
  balance?: { url: string; amounts: PayoutAmount[] } | null;
  rate?: ExchangeRate | null;
  /** Embed timestamp and footer date; now when omitted. */
  at?: Date;
}

export const USERNAME = "Treasury Guild";
/** Workgroups listed in the spending/budget blocks before "+N more" (field values cap at 1024 chars). */
export const MAX_WORKGROUP_LINES = 8;
const MAX_WORKGROUP_NAME = 40;
const COLOR_INDIGO = 0x6366f1;

function formatAmount(a: PayoutAmount): string {
  return formatUnits(a.quantity, a.decimals, a.ticker);
}

function formatAmounts(amounts: PayoutAmount[]): string {
  return amounts.map(formatAmount).join(" + ");
}

/**
 * Discord fenced code block. `css` is the language Discord colours most
 * usefully for "amount TICKER" lines (numbers and words get distinct tones),
 * so figures stand out from the prose around them.
 */
export function codeBlock(lines: string[], lang = "css"): string {
  return "```" + lang + "\n" + lines.join("\n") + "\n```";
}

/** One line of an embed: whitespace collapsed, then cut to `max`. */
function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

function sumAmounts(into: Map<string, PayoutAmount>, amounts: PayoutAmount[], times: bigint): void {
  for (const a of amounts) {
    const cur = into.get(a.ticker);
    if (cur) cur.quantity += a.quantity * times;
    else into.set(a.ticker, { ...a, quantity: a.quantity * times });
  }
}

/** Per-asset totals across the whole transaction (amount × recipients per task). */
export function payoutTotals(tasks: PayoutMessageTask[]): PayoutAmount[] {
  const totals = new Map<string, PayoutAmount>();
  for (const task of tasks) sumAmounts(totals, task.amounts, BigInt(task.recipientWallets.length));
  return [...totals.values()];
}

export interface WorkgroupSpending {
  workgroupName: string;
  amounts: PayoutAmount[];
}

/** What each workgroup was paid in this transaction, sorted by name. */
export function workgroupSpending(tasks: PayoutMessageTask[]): WorkgroupSpending[] {
  const byName = new Map<string, Map<string, PayoutAmount>>();
  for (const task of tasks) {
    let totals = byName.get(task.workgroupName);
    if (!totals) {
      totals = new Map();
      byName.set(task.workgroupName, totals);
    }
    sumAmounts(totals, task.amounts, BigInt(task.recipientWallets.length));
  }
  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workgroupName, totals]) => ({ workgroupName, amounts: [...totals.values()] }));
}

function moreLine(hidden: number, what: string): string[] {
  return hidden > 0 ? [`…and ${hidden} more ${what}${hidden === 1 ? "" : "s"}`] : [];
}

/** `Dev: 450 ADA + 250 GVT`, one line per workgroup, capped. */
export function spendingLines(spending: WorkgroupSpending[]): string[] {
  const shown = spending.slice(0, MAX_WORKGROUP_LINES);
  return [
    ...shown.map((s) => `${oneLine(s.workgroupName, MAX_WORKGROUP_NAME)}: ${formatAmounts(s.amounts)}`),
    ...moreLine(spending.length - shown.length, "workgroup"),
  ];
}

/** `2,550 / 3,000 ADA left` or `over by 200 ADA`. */
export function budgetLine(b: BudgetBalanceLine): string {
  const left = b.allocated - b.spent;
  if (left < 0n) return `over by ${formatUnits(-left, b.decimals, b.ticker)}`;
  return `${formatUnits(left, b.decimals)} / ${formatUnits(b.allocated, b.decimals, b.ticker)} left`;
}

/**
 * One block per workgroup paid (same order and cap as the spending block):
 *   Dev — September 2026
 *     2,550 / 3,000 ADA left
 *   Design — no budget
 */
export function budgetLines(spending: WorkgroupSpending[], budgets: BudgetBalanceLine[]): string[] {
  const shown = spending.slice(0, MAX_WORKGROUP_LINES);
  const lines: string[] = [];
  for (const s of shown) {
    const name = oneLine(s.workgroupName, MAX_WORKGROUP_NAME);
    const rows = budgets.filter((b) => b.workgroupName === s.workgroupName);
    if (rows.length === 0) {
      lines.push(`${name} — no budget`);
      continue;
    }
    lines.push(`${name} — ${rows[0]!.periodLabel}`);
    for (const b of rows) lines.push(`  ${budgetLine(b)}`);
  }
  return [...lines, ...moreLine(spending.length - shown.length, "workgroup")];
}

function formatPrice(price: number): string {
  return price >= 1
    ? price.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : price.toLocaleString("en", { maximumSignificantDigits: 4 });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "15 Sep 2026" (UTC). Fixed names: Intl's en-GB says "Sept", and ICU data varies by runtime. */
export function footerDate(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** `Exchange rate — 0.42 USD per ADA — 15 Sep 2026`, or just the date. */
export function footerText(rate: ExchangeRate | null | undefined, at: Date): string {
  const date = footerDate(at);
  if (!rate) return date;
  return `Exchange rate — ${formatPrice(rate.price)} ${rate.currency.toUpperCase()} per ${rate.symbol.toUpperCase()} — ${date}`;
}

export function buildPayoutEmbed(input: PayoutMessageInput): DiscordWebhookPayload {
  const at = input.at ?? new Date();
  const explorer = explorerTxUrl(input.network, input.txHash);
  const spending = workgroupSpending(input.tasks);
  const totals = payoutTotals(input.tasks);
  const wallets = new Set(input.tasks.flatMap((t) => t.recipientWallets));

  const links = [
    input.links?.transaction ? `[Transaction](${input.links.transaction})` : null,
    input.links?.dashboard ? `[Dashboard](${input.links.dashboard})` : null,
    `[Explorer](${explorer})`,
  ].filter((l): l is string => l !== null);

  const fields: DiscordEmbedField[] = [
    { name: "Total paid", value: codeBlock(totals.length > 0 ? totals.map(formatAmount) : ["—"]) },
    { name: "Spending by workgroup", value: codeBlock(spendingLines(spending)) },
    { name: "Budget balance", value: codeBlock(budgetLines(spending, input.budgets)) },
  ];
  if (input.balance) {
    fields.push({
      name: "Treasury balance",
      value: `[${input.treasuryName} on explorer](${input.balance.url})\n${codeBlock(
        input.balance.amounts.length > 0 ? input.balance.amounts.map(formatAmount) : ["—"],
      )}`,
    });
  }
  fields.push(
    { name: "Tasks", value: String(input.tasks.length), inline: true },
    { name: "Recipients", value: String(wallets.size), inline: true },
    { name: "Transaction", value: `[\`${shortHash(input.txHash, 16)}\`](${explorer})`, inline: true },
  );

  return {
    username: USERNAME,
    embeds: [
      {
        author: {
          name: input.community.name,
          ...(input.community.url ? { url: input.community.url } : {}),
          ...(input.community.iconUrl ? { icon_url: input.community.iconUrl } : {}),
        },
        title: `💸 Payout from ${input.treasuryName}`,
        url: explorer,
        description: links.join("  ·  "),
        color: COLOR_INDIGO,
        fields,
        footer: { text: footerText(input.rate, at) },
        timestamp: at.toISOString(),
      },
    ],
  };
}

/** Discord's embed size limits (characters), per https://discord.com/developers/docs/resources/message#embed-object-embed-limits */
export const DISCORD_LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  fields: 25,
  footer: 2048,
  author: 256,
  /** title + description + fields + footer + author, summed over all embeds. */
  embedTotal: 6000,
} as const;

export interface EmbedUsage {
  /** Characters across all embed descriptions. */
  description: number;
  /** Characters counted against the 6000 total. */
  total: number;
  /** Human labels of every limit the payload exceeds; empty = Discord will accept it. */
  over: string[];
}

export function embedUsage(payload: DiscordWebhookPayload): EmbedUsage {
  let description = 0;
  let total = 0;
  const over: string[] = [];
  payload.embeds.forEach((embed, i) => {
    const where = payload.embeds.length > 1 ? `embed ${i + 1} ` : "";
    total += embed.title.length;
    if (embed.title.length > DISCORD_LIMITS.title) over.push(`${where}title`);
    const d = embed.description?.length ?? 0;
    description += d;
    total += d;
    if (d > DISCORD_LIMITS.description) over.push(`${where}description`);
    const fields = embed.fields ?? [];
    if (fields.length > DISCORD_LIMITS.fields) over.push(`${where}field count`);
    for (const f of fields) {
      total += f.name.length + f.value.length;
      if (f.name.length > DISCORD_LIMITS.fieldName) over.push(`${where}field "${f.name}" name`);
      if (f.value.length > DISCORD_LIMITS.fieldValue) over.push(`${where}field "${f.name}" value`);
    }
    const footer = embed.footer?.text.length ?? 0;
    total += footer;
    if (footer > DISCORD_LIMITS.footer) over.push(`${where}footer`);
    const author = embed.author?.name.length ?? 0;
    total += author;
    if (author > DISCORD_LIMITS.author) over.push(`${where}author`);
  });
  if (total > DISCORD_LIMITS.embedTotal) over.push("embed total");
  return { description, total, over };
}

/** Posted once when an admin connects a webhook, so a bad URL fails right away. */
export function buildConnectedEmbed(treasuryName: string): DiscordWebhookPayload {
  return {
    username: USERNAME,
    embeds: [
      {
        title: "🔗 Treasury Guild connected",
        description: `Payout notifications for **${treasuryName}** will appear in this channel once each payout is confirmed on-chain.`,
        color: COLOR_INDIGO,
      },
    ],
  };
}
