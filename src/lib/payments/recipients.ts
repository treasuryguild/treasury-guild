// Pure resolution of a manual payment's recipients: what the Payments page
// submits (addresses with display-unit amounts per token) becomes one
// output per distinct address with exact on-chain quantities, or a list of
// problems. Client-safe; the build-payment route feeds it the treasury's
// wallet tokens, sibling treasuries and member handles.

import { ADA_ASSET, addQuantity, LOVELACE, scaleDecimal } from "@/lib/assets";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import type { Network } from "@/lib/config";
import { MAX_PAYOUT_CONTRIBUTORS } from "@/lib/constants";
import { shortAddress } from "@/lib/format";

/** A resolved recipient: mirrors `PaymentRecipient` in cardano/paymentBuilder.ts (server-only). */
export interface ResolvedPaymentRecipient {
  address: string;
  treasuryId: string | null;
  label: string | null;
  amounts: { unit: string; quantity: bigint }[];
}

export interface PaymentRecipientInput {
  address: string;
  /** unit ("lovelace" or policyId+assetNameHex) -> amount in display units. */
  amounts: Record<string, string>;
}

export interface PaymentRecipientContext {
  network: Network;
  /** The paying wallet; paying it back to itself is refused. */
  treasuryAddress: string;
  /** The community's other treasuries, by address. */
  siblingTreasuries: readonly { id: string; name: string; address: string }[];
  /** Member wallet -> display label (handle, GitHub login or null). */
  members: ReadonlyMap<string, string | null>;
  /** Tokens the paying wallet holds (ADA is built in), with the decimals their amounts use. */
  tokens: ReadonlyMap<string, { ticker: string; decimals: number }>;
}

export interface ResolvedPaymentRecipients {
  recipients: ResolvedPaymentRecipient[];
  problems: string[];
}

/**
 * Validate and aggregate recipients. Rows naming the same address merge into
 * one output (amounts summed per unit); the first-seen order of addresses is
 * the output order. Every problem is reported, none silently dropped.
 */
export function resolvePaymentRecipients(
  inputs: readonly PaymentRecipientInput[],
  ctx: PaymentRecipientContext,
): ResolvedPaymentRecipients {
  const problems: string[] = [];
  const byAddress = new Map<string, Map<string, bigint>>();
  const siblings = new Map(ctx.siblingTreasuries.map((t) => [t.address, t]));

  for (const input of inputs) {
    const address = input.address.trim();
    const who = siblings.get(address)?.name ?? ctx.members.get(address) ?? shortAddress(address);
    if (address === ctx.treasuryAddress) {
      problems.push(`${who}: this is the paying treasury itself`);
      continue;
    }
    if (addressToNetwork(address) !== ctx.network) {
      problems.push(`${who}: address is on a different network`);
      continue;
    }
    const amounts = byAddress.get(address) ?? new Map<string, bigint>();
    let paid = false;
    const before = problems.length;
    for (const [unit, raw] of Object.entries(input.amounts)) {
      if (raw.trim() === "") continue;
      const token = unit === LOVELACE
        ? { ticker: ADA_ASSET.fieldName, decimals: ADA_ASSET.decimals }
        : ctx.tokens.get(unit);
      if (!token) {
        problems.push(`${who}: token ${shortAddress(unit)} is not held by this treasury`);
        continue;
      }
      let quantity: bigint;
      try {
        quantity = scaleDecimal(raw, token.decimals);
      } catch {
        problems.push(`${who}: invalid ${token.ticker} amount "${raw}"`);
        continue;
      }
      if (quantity <= 0n) {
        problems.push(`${who}: ${token.ticker} amount must be greater than zero`);
        continue;
      }
      addQuantity(amounts, unit, quantity);
      paid = true;
    }
    if (problems.length > before) continue;
    if (!paid && amounts.size === 0) {
      problems.push(`${who}: no amount entered`);
      continue;
    }
    byAddress.set(address, amounts);
  }

  if (byAddress.size > MAX_PAYOUT_CONTRIBUTORS) {
    problems.push(`At most ${MAX_PAYOUT_CONTRIBUTORS} recipients per payment (${byAddress.size} given)`);
  }

  const recipients: ResolvedPaymentRecipient[] = [...byAddress].map(([address, amounts]) => {
    const sibling = siblings.get(address);
    return {
      address,
      treasuryId: sibling?.id ?? null,
      label: sibling?.name ?? ctx.members.get(address) ?? null,
      // Lovelace first, then tokens in the order they were entered.
      amounts: [...amounts].sort(([a], [b]) => (a === LOVELACE ? -1 : b === LOVELACE ? 1 : 0))
        .map(([unit, quantity]) => ({ unit, quantity })),
    };
  });
  return { recipients, problems };
}

/** Sum of every recipient's amounts per unit, for balance checks and summaries. */
export function paymentTotals(recipients: readonly ResolvedPaymentRecipient[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const r of recipients) {
    for (const a of r.amounts) addQuantity(totals, a.unit, a.quantity);
  }
  return totals;
}
