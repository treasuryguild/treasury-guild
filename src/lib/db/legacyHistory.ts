// Service-role reads and writes of previous-wallet history (migration 0050):
// the wallets, their CSV imports and lines, the context an upload is planned
// against, the import_legacy_history RPC and the Dashboard's spend reads.
// Amounts are selected as text: numeric arrives as a JSON number otherwise,
// which is not exact past 2^53.
import "server-only";

import type { LegacyHistoryImportResponse, LegacyImportSummary, LegacyPaymentView, LegacyWalletSummary } from "@/lib/api/types";
import { addQuantity } from "@/lib/assets";
import type { AssetDef } from "@/lib/assets";
import { PgCode } from "@/lib/constants";
import { recipientLabel, type KnownWallet } from "@/lib/legacyHistory/display";
import type { LegacyRpcRow, LegacyToken, LegacyWorkgroup } from "@/lib/legacyHistory/types";
import { ConflictError } from "@/lib/errors";
import { loadAssetRegistry } from "./assets";
import { loadBudgetSetupsForWorkgroups, type BudgetSetupCadenceRow } from "./budgetSetups";
import { allRows, check, maybe, must, optionalRelation, relation, rows, rpc, serviceClient } from "./client";
import {
  LEGACY_AMOUNT_COLUMNS, LEGACY_IMPORT_COLUMNS, LEGACY_PAYMENT_COLUMNS, LEGACY_WALLET_COLUMNS,
  MEMBER_WITH_CONTRIBUTOR_COLUMNS, type LegacyAmountRow, type LegacyImportRow, type LegacyPaymentRow,
  type LegacyWalletRow, type MemberWithContributor,
} from "./types";

// --- Wallets ---------------------------------------------------------------------

export async function loadLegacyWallet(id: string): Promise<LegacyWalletRow | null> {
  return maybe<LegacyWalletRow>(
    await serviceClient().from("legacy_wallets").select(LEGACY_WALLET_COLUMNS).eq("id", id).maybeSingle(),
    "load previous wallet",
  );
}

export async function loadLegacyWallets(communityId: string): Promise<LegacyWalletRow[]> {
  return rows<LegacyWalletRow>(
    await serviceClient()
      .from("legacy_wallets")
      .select(LEGACY_WALLET_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at"),
    "load previous wallets",
  );
}

const NAME_TAKEN = "This community already has a previous wallet with that name";

export async function createLegacyWallet(row: {
  community_id: string;
  name: string;
  address: string | null;
  created_by: string;
}): Promise<LegacyWalletRow> {
  const res = await serviceClient().from("legacy_wallets").insert(row).select(LEGACY_WALLET_COLUMNS).single();
  if (res.error?.code === PgCode.UniqueViolation) throw new ConflictError(NAME_TAKEN);
  return must<LegacyWalletRow>(res, "create previous wallet");
}

export async function updateLegacyWallet(id: string, patch: { name?: string; address?: string | null }): Promise<void> {
  const res = await serviceClient().from("legacy_wallets").update(patch).eq("id", id);
  if (res.error?.code === PgCode.UniqueViolation) throw new ConflictError(NAME_TAKEN);
  check(res, "update previous wallet");
}

/** Removes the wallet with every import and line of it. */
export async function deleteLegacyWallet(id: string): Promise<void> {
  check(await serviceClient().from("legacy_wallets").delete().eq("id", id), "delete previous wallet");
}

// --- Imports and lines -------------------------------------------------------------

export async function loadLegacyImport(id: string): Promise<LegacyImportRow | null> {
  return maybe<LegacyImportRow>(
    await serviceClient().from("legacy_imports").select(LEGACY_IMPORT_COLUMNS).eq("id", id).maybeSingle(),
    "load history import",
  );
}

export async function deleteLegacyImport(id: string): Promise<void> {
  check(await serviceClient().from("legacy_imports").delete().eq("id", id), "delete history import");
}

export async function loadLegacyPayment(id: string): Promise<Pick<LegacyPaymentRow, "id" | "import_id" | "community_id"> | null> {
  return maybe(
    await serviceClient().from("legacy_payments").select("id, import_id, community_id").eq("id", id).maybeSingle(),
    "load history line",
  );
}

/** Removes one line, and its import once nothing of it is left. */
export async function deleteLegacyPayment(id: string, importId: string): Promise<void> {
  const db = serviceClient();
  check(await db.from("legacy_payments").delete().eq("id", id), "delete history line");
  const left = await db.from("legacy_payments").select("id", { count: "exact", head: true }).eq("import_id", importId);
  check(left, "count history lines");
  if (left.count === 0) await deleteLegacyImport(importId);
}

export interface ImportLegacyArgs {
  walletId: string;
  fileName: string;
  actor: string;
  rows: LegacyRpcRow[];
  replaceImportId: string | null;
  includeDuplicates: boolean;
}

export async function importLegacyHistory(args: ImportLegacyArgs): Promise<LegacyHistoryImportResponse> {
  return rpc<LegacyHistoryImportResponse>(
    await serviceClient().rpc("import_legacy_history", {
      p_legacy_wallet_id: args.walletId,
      p_file_name: args.fileName,
      p_actor: args.actor,
      p_rows: args.rows,
      p_replace_import_id: args.replaceImportId,
      p_skip_existing: !args.includeDuplicates,
    }),
  );
}

// --- Planning context --------------------------------------------------------------

export interface LegacyImportContext {
  network: number;
  workgroups: LegacyWorkgroup[];
  aliases: Map<string, string>;
  registry: AssetDef[];
  history: LegacyToken[];
  existingKeys: Set<string>;
  setups: Map<string, BudgetSetupCadenceRow[]>;
  treasuryAddresses: string[];
}

/** What an upload to `walletId` is planned against; `excludeImportId` is a batch being replaced. */
export async function loadLegacyImportContext(
  communityId: string,
  walletId: string,
  excludeImportId: string | null,
): Promise<LegacyImportContext> {
  const db = serviceClient();
  const [community, workgroups, aliases, registry, history, keys, treasuries] = await Promise.all([
    db.from("communities").select("network").eq("id", communityId).single(),
    db.from("workgroups").select("id, name, archived_at").eq("community_id", communityId),
    db.from("workgroup_import_aliases").select("name, workgroup_id").eq("community_id", communityId),
    loadAssetRegistry(communityId),
    allRows<LegacyToken & { legacy_payments: unknown }>((from, to) => db
      .from("legacy_payment_amounts")
      .select("unit, ticker, decimals, legacy_payments!inner(community_id)")
      .eq("legacy_payments.community_id", communityId)
      .order("payment_id")
      .order("unit")
      .range(from, to), "load history tokens"),
    allRows<{ dedupe_key: string; import_id: string }>((from, to) => db
      .from("legacy_payments")
      .select("dedupe_key, import_id")
      .eq("legacy_wallet_id", walletId)
      .order("id")
      .range(from, to), "load history keys"),
    db.from("treasuries").select("address").eq("community_id", communityId),
  ]);
  const groups = rows<{ id: string; name: string; archived_at: string | null }>(workgroups, "load workgroups");
  const tokens = new Map(history.map((t) => [`${t.unit}:${t.ticker.toLowerCase()}`, { unit: t.unit, ticker: t.ticker, decimals: t.decimals }]));
  return {
    network: must<{ network: number }>(community, "load community network").network,
    workgroups: groups.map((w) => ({ id: w.id, name: w.name, archived: w.archived_at !== null })),
    aliases: new Map(rows<{ name: string; workgroup_id: string }>(aliases, "load workgroup aliases").map((a) => [a.name, a.workgroup_id])),
    registry,
    history: [...tokens.values()],
    existingKeys: new Set(keys.filter((k) => k.import_id !== excludeImportId).map((k) => k.dedupe_key)),
    setups: await loadBudgetSetupsForWorkgroups(groups.map((w) => w.id)),
    treasuryAddresses: rows<{ address: string }>(treasuries, "load treasuries").map((t) => t.address),
  };
}

/** Members and task assignees with their profiles: whom a recipient's address end can name. */
export async function loadKnownWallets(communityId: string): Promise<KnownWallet[]> {
  const db = serviceClient();
  const [members, assignees] = await Promise.all([
    allRows<MemberWithContributor>((from, to) => db
      .from("community_members")
      .select(MEMBER_WITH_CONTRIBUTOR_COLUMNS)
      .eq("community_id", communityId)
      .order("wallet_address")
      .range(from, to), "load members"),
    allRows<{ wallet_address: string | null }>((from, to) => db
      .from("task_assignees")
      .select("wallet_address, tasks!inner(community_id)")
      .eq("tasks.community_id", communityId)
      .not("wallet_address", "is", null)
      .order("id")
      .range(from, to), "load assignee wallets"),
  ]);
  const known = new Map<string, KnownWallet>();
  for (const m of members) {
    const profile = optionalRelation(m.contributors);
    known.set(m.wallet_address, {
      wallet: m.wallet_address,
      handle: profile?.handle ?? null,
      githubUsername: profile?.github_username ?? null,
    });
  }
  const others = [...new Set(assignees.map((a) => a.wallet_address!))].filter((w) => !known.has(w));
  for (let i = 0; i < others.length; i += 200) {
    const profiles = rows<{ wallet_address: string; handle: string | null; github_username: string | null }>(
      await db.from("contributors").select("wallet_address, handle, github_username").in("wallet_address", others.slice(i, i + 200)),
      "load assignee profiles",
    );
    for (const p of profiles) known.set(p.wallet_address, { wallet: p.wallet_address, handle: p.handle, githubUsername: p.github_username });
  }
  return [...known.values()];
}

// --- Overview and lines ------------------------------------------------------------

interface AmountWithPayment extends LegacyAmountRow {
  payment_id: string;
  legacy_payments: { import_id: string; legacy_wallet_id: string; paid_on: string };
}

interface Stats {
  payments: Set<string>;
  first: string | null;
  last: string | null;
  totals: Map<string, bigint>;
}

function emptyStats(): Stats {
  return { payments: new Set(), first: null, last: null, totals: new Map() };
}

/** The community's previous wallets and imports with what each still holds. */
export async function loadLegacyOverview(
  communityId: string,
): Promise<{ wallets: LegacyWalletSummary[]; imports: LegacyImportSummary[] }> {
  const db = serviceClient();
  const [wallets, imports, amounts] = await Promise.all([
    loadLegacyWallets(communityId),
    db.from("legacy_imports").select(LEGACY_IMPORT_COLUMNS).eq("community_id", communityId).order("created_at", { ascending: false }),
    allRows<AmountWithPayment>((from, to) => db
      .from("legacy_payment_amounts")
      .select(`payment_id, ${LEGACY_AMOUNT_COLUMNS}, legacy_payments!inner(import_id, legacy_wallet_id, paid_on, community_id)`)
      .eq("legacy_payments.community_id", communityId)
      .order("payment_id")
      .order("unit")
      .range(from, to), "load history amounts"),
  ]);
  const byWallet = new Map<string, Stats>();
  const byImport = new Map<string, Stats>();
  const tokens = new Map<string, { ticker: string; decimals: number }>();
  for (const a of amounts) {
    const payment = relation(a.legacy_payments);
    tokens.set(a.unit, { ticker: a.ticker, decimals: a.decimals });
    for (const [map, key] of [[byWallet, payment.legacy_wallet_id], [byImport, payment.import_id]] as const) {
      const stats = map.get(key) ?? emptyStats();
      stats.payments.add(a.payment_id);
      if (stats.first === null || payment.paid_on < stats.first) stats.first = payment.paid_on;
      if (stats.last === null || payment.paid_on > stats.last) stats.last = payment.paid_on;
      addQuantity(stats.totals, a.unit, BigInt(a.amount));
      map.set(key, stats);
    }
  }
  return {
    wallets: wallets.map((w) => {
      const stats = byWallet.get(w.id) ?? emptyStats();
      return {
        id: w.id,
        name: w.name,
        address: w.address,
        createdAt: w.created_at,
        rowCount: stats.payments.size,
        firstPaidOn: stats.first,
        lastPaidOn: stats.last,
      };
    }),
    imports: rows<LegacyImportRow>(imports, "load history imports").map((i) => {
      const stats = byImport.get(i.id) ?? emptyStats();
      return {
        id: i.id,
        legacyWalletId: i.legacy_wallet_id,
        fileName: i.file_name,
        createdAt: i.created_at,
        createdBy: i.created_by,
        lineCount: i.line_count,
        rowCount: stats.payments.size,
        firstPaidOn: stats.first,
        lastPaidOn: stats.last,
        totals: [...stats.totals].map(([unit, amount]) => ({
          workgroupId: null,
          unit,
          ticker: tokens.get(unit)?.ticker ?? unit,
          decimals: tokens.get(unit)?.decimals ?? 0,
          amount: amount.toString(),
        })),
      };
    }),
  };
}

interface PaymentWithDetail extends LegacyPaymentRow {
  legacy_payment_amounts: LegacyAmountRow[];
  workgroups: { name: string; archived_at: string | null };
}

export const LEGACY_ROWS_PAGE = 200;

/** One page of lines, newest payment first, with recipients named where the address end is unambiguous. */
export async function loadLegacyRows(
  communityId: string,
  filter: { importId?: string; walletId?: string; offset: number },
): Promise<{ rows: LegacyPaymentView[]; total: number }> {
  let query = serviceClient()
    .from("legacy_payments")
    .select(`${LEGACY_PAYMENT_COLUMNS}, legacy_payment_amounts(${LEGACY_AMOUNT_COLUMNS}), workgroups(name, archived_at)`, { count: "exact" })
    .eq("community_id", communityId);
  if (filter.importId) query = query.eq("import_id", filter.importId);
  if (filter.walletId) query = query.eq("legacy_wallet_id", filter.walletId);
  const res = await query
    .order("paid_on", { ascending: false })
    .order("line_no")
    .order("id")
    .range(filter.offset, filter.offset + LEGACY_ROWS_PAGE - 1);
  const page = rows<PaymentWithDetail>(res, "load history lines");
  const known = page.length > 0 ? await loadKnownWallets(communityId) : [];
  return {
    total: res.count ?? page.length,
    rows: page.map((p) => {
      const group = relation(p.workgroups);
      return {
        id: p.id,
        importId: p.import_id,
        legacyWalletId: p.legacy_wallet_id,
        lineNo: p.line_no,
        recipientRef: p.recipient_ref,
        recipientLabel: recipientLabel(p.recipient_ref, known),
        task: p.task,
        paidOn: p.paid_on,
        budgetMonth: p.budget_month,
        workgroupId: p.workgroup_id,
        workgroupName: group?.name ?? "Workgroup",
        workgroupArchived: !!group?.archived_at,
        amounts: [...p.legacy_payment_amounts].sort((a, b) => a.unit.localeCompare(b.unit)),
      };
    }),
  };
}

// --- Dashboard ---------------------------------------------------------------------

/** One token amount of one imported line, as the Dashboard counts it. */
export interface LegacySpendRow {
  /** `${paymentId}:${unit}` */
  id: string;
  legacyWalletId: string;
  workgroupId: string;
  workgroupName: string;
  /** The end of the receiver's address (or a whole address). */
  recipientRef: string;
  task: string;
  paidOn: string;
  /** "YYYY-MM-DD", day 1 of the budget period. */
  budgetMonth: string;
  unit: string;
  ticker: string;
  decimals: number;
  amount: string;
}

interface SpendAmountRow extends LegacyAmountRow {
  payment_id: string;
  legacy_payments: {
    legacy_wallet_id: string;
    workgroup_id: string;
    recipient_ref: string;
    task: string;
    paid_on: string;
    budget_month: string;
    workgroups: { name: string };
  };
}

/** Imported lines whose budget month is in [from, to) ("YYYY-MM-DD"; `from` null = no lower bound). */
export async function loadLegacySpend(
  communityId: string,
  range: { from: string | null; to: string },
): Promise<LegacySpendRow[]> {
  const db = serviceClient();
  const found = await allRows<SpendAmountRow>((from, to) => {
    let query = db
      .from("legacy_payment_amounts")
      .select(
        `payment_id, ${LEGACY_AMOUNT_COLUMNS}, legacy_payments!inner(legacy_wallet_id, workgroup_id, recipient_ref, task, paid_on, budget_month, community_id, workgroups(name))`,
      )
      .eq("legacy_payments.community_id", communityId)
      .lt("legacy_payments.budget_month", range.to);
    if (range.from !== null) query = query.gte("legacy_payments.budget_month", range.from);
    return query.order("payment_id").order("unit").range(from, to);
  }, "load history spend");
  return found.map((a) => {
    const payment = relation(a.legacy_payments);
    return {
      id: `${a.payment_id}:${a.unit}`,
      legacyWalletId: payment.legacy_wallet_id,
      workgroupId: payment.workgroup_id,
      workgroupName: optionalRelation(payment.workgroups)?.name ?? "Workgroup",
      recipientRef: payment.recipient_ref,
      task: payment.task,
      paidOn: payment.paid_on,
      budgetMonth: payment.budget_month,
      unit: a.unit,
      ticker: a.ticker,
      decimals: a.decimals,
      amount: a.amount,
    };
  });
}
