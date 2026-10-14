// A "Fund this budget" link (docs/onchain-anchoring-estimate.md, phase 5):
// the Payments page opened with a transfer to the receiving treasury, one
// period's voted amounts and the budget proposal to cite, all in the query
// string. The page fills the form from it; the admin picks the paying
// treasury and can edit everything. Pure and client-safe; the route
// re-checks the proposal and the amounts, as it does for any request.
import { BUDGET_MONTH_RE } from "@/lib/budgets";
import { isUuid } from "@/lib/guards";

export interface PaymentPrefill {
  /** The receiving treasury. */
  treasuryId: string;
  /** The budget period funded ("YYYY-MM", the period's first month). */
  month: string;
  /** The applied budget proposal the transfer cites. */
  proposalId: string;
  /** unit -> display amount, as the form's inputs take it. */
  amounts: Record<string, string>;
}

const AMOUNT_RE = /^\d+(?:\.\d+)?$/;
const UNIT_RE = /^(?:lovelace|[0-9a-f]{56,})$/;

/** The query string of a prefilled Payments link (no leading "?"). */
export function paymentPrefillQuery(prefill: PaymentPrefill): string {
  const params = new URLSearchParams({ to: prefill.treasuryId, month: prefill.month, proposal: prefill.proposalId });
  const amounts = Object.entries(prefill.amounts).filter(([, amount]) => amount !== "");
  if (amounts.length > 0) params.set("amounts", amounts.map(([unit, amount]) => `${unit}:${amount}`).join(","));
  return params.toString();
}

/** A well-formed prefill from a page's search params, else null (a stray or tampered link fills nothing). */
export function parsePaymentPrefill(query: Record<string, string | string[] | undefined>): PaymentPrefill | null {
  const one = (key: string) => (typeof query[key] === "string" ? query[key] : undefined);
  const treasuryId = one("to");
  const month = one("month");
  const proposalId = one("proposal");
  if (!treasuryId || !isUuid(treasuryId) || !month || !BUDGET_MONTH_RE.test(month) || !proposalId || !isUuid(proposalId)) return null;
  const amounts: Record<string, string> = {};
  for (const pair of (one("amounts") ?? "").split(",").filter(Boolean)) {
    const at = pair.indexOf(":");
    const unit = pair.slice(0, at);
    const amount = pair.slice(at + 1);
    if (at < 0 || !UNIT_RE.test(unit) || !AMOUNT_RE.test(amount)) return null;
    amounts[unit] = amount;
  }
  return { treasuryId, month, proposalId, amounts };
}

/** Whether a value is a PaymentPrefill (the routes helper is also called with a bare string by the docs test). */
export function isPaymentPrefill(value: unknown): value is PaymentPrefill {
  return typeof value === "object" && value !== null && "treasuryId" in value && "month" in value && "proposalId" in value;
}
