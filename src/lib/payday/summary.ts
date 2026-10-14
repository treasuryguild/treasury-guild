// Selection summary for the Payday page.
//
// Totals are exact but in the amounts' own precision: a field's decimals are
// not known until its token is connected, so each total keeps the most
// fractional digits any of its amounts used (`totalInBaseUnits` rescales it
// once the asset is known). The build route stays the authority. Every
// assignee of a task is paid the full amounts, so a task's amounts count once
// per assignee wallet.

import { assigneeWallets } from "@/lib/assignees";
import { ADA_ASSET, scaleDecimal } from "@/lib/assets";
import { MAX_PAYOUT_CONTRIBUTORS, TOKEN_CONTRIBUTOR_WARNING } from "@/lib/constants";
import { formatUnits } from "@/lib/format";
import { isPayable, taskAmounts } from "./selection";
import type { PayableTask } from "./types";

/** An exact total: `quantity` counted at `decimals` fractional digits. */
export interface PreviewTotal {
  quantity: bigint;
  decimals: number;
}

const DECIMAL_RE = /^\d+(?:\.(\d+))?$/;

/** `total` plus `value` × `times`, exact. A value that is not a decimal number adds nothing. */
export function addPreviewAmount(total: PreviewTotal | undefined, value: string, times: number): PreviewTotal {
  const base = total ?? { quantity: 0n, decimals: 0 };
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) return base;
  const decimals = Math.max(base.decimals, m[1]?.length ?? 0);
  const quantity = base.quantity * 10n ** BigInt(decimals - base.decimals);
  return { quantity: quantity + scaleDecimal(value, decimals) * BigInt(times), decimals };
}

/** A total in the base units of an asset with `decimals`, rounded up: a preview never under-reports what is owed. */
export function totalInBaseUnits(total: PreviewTotal, decimals: number): bigint {
  if (total.decimals <= decimals) return total.quantity * 10n ** BigInt(decimals - total.decimals);
  const divisor = 10n ** BigInt(total.decimals - decimals);
  return (total.quantity + divisor - 1n) / divisor;
}

export interface PaydaySummary {
  count: number;
  /** (task, wallet) payments — a task with three assignees is three. */
  payments: number;
  wallets: Set<string>;
  /** field name -> exact total (preview only). */
  totals: Map<string, PreviewTotal>;
  fields: string[];
  hasTokens: boolean;
  tooManyContributors: boolean;
  contributorWarning: boolean;
  selectedWorkgroupIds: Set<string>;
}

const isAda = (field: string) => field.toLowerCase() === ADA_ASSET.fieldName.toLowerCase();

export function summarizeSelection(
  tasks: PayableTask[],
  selected: ReadonlySet<string>,
): PaydaySummary {
  const chosen = tasks.filter((t) => selected.has(t.id));
  const wallets = new Set<string>();
  const totals = new Map<string, PreviewTotal>();
  const selectedWorkgroupIds = new Set<string>();
  let payments = 0;
  for (const t of chosen) {
    selectedWorkgroupIds.add(t.workgroup_id);
    if (!isPayable(t)) continue;
    const recipients = assigneeWallets(t.task_assignees);
    for (const w of recipients) wallets.add(w);
    payments += recipients.length;
    for (const [field, value] of Object.entries(taskAmounts(t))) {
      totals.set(field, addPreviewAmount(totals.get(field), value, recipients.length));
    }
  }
  const fields = [...totals.keys()];
  const hasTokens = fields.some((f) => !isAda(f));
  return {
    count: chosen.length,
    payments,
    wallets,
    totals,
    fields,
    hasTokens,
    tooManyContributors: wallets.size > MAX_PAYOUT_CONTRIBUTORS,
    contributorWarning: hasTokens && wallets.size > TOKEN_CONTRIBUTOR_WARNING,
    selectedWorkgroupIds,
  };
}

/** "150 ₳ + 300 HOSKY" preview line. */
export function describeTotals(totals: Map<string, PreviewTotal>): string {
  return [...totals.entries()]
    .map(([field, total]) => formatUnits(total.quantity, total.decimals, isAda(field) ? "₳" : field))
    .join(" + ");
}
