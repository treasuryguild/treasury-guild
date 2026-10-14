// Step 1 of the co-signer check, pure: does the transaction's own CBOR move
// exactly what the rows the app stored for it say? Nothing leaves the
// treasury except those outputs (rebuilt with the builders' own planner, so
// the min-UTxO bump matches), plus change back to the treasury; the label
// 190001 record names the same tasks and transfers; a mint forges exactly
// the recorded assets. Every problem is returned in words. Client-safe.

import { LOVELACE } from "@/lib/assets";
import { parsePayoutMetadata, type PayoutMetadata } from "@/lib/cardano/metadata";
import { parsePaymentMetadata, type PaymentMetadata } from "@/lib/cardano/paymentMetadata";
import { planOutputs } from "@/lib/cardano/payoutOutputs";
import type { DecodedTxMint, DecodedTxOutput } from "@/lib/cardano/types";
import { minLovelaceForOutput } from "@/lib/cardano/utxoSelect";
import { TxKind } from "@/lib/constants";

export interface StoredPayout {
  taskNumber: number;
  contributorWallet: string;
  unit: string;
  /** Base units, as stored. */
  amount: string;
}

export interface StoredPayment {
  recipientWallet: string;
  recipientTreasuryId: string | null;
  unit: string;
  amount: string;
}

export interface StoredMint {
  policyId: string;
  assetNameHex: string;
  quantity: string;
  recipient: string;
}

export interface CompareInput {
  kind: string;
  treasuryAddress: string;
  /** Addresses of the community's other treasuries: where a transfer may go. */
  siblingAddresses: ReadonlySet<string>;
  /** The transaction's outputs in body order. */
  outputs: readonly DecodedTxOutput[];
  mint: readonly DecodedTxMint[];
  /** The decoded label-190001 record, if any. */
  payoutMeta: unknown;
  payouts: readonly StoredPayout[];
  payments: readonly StoredPayment[];
  mints: readonly StoredMint[];
}

interface Leaving {
  index: number;
  output: DecodedTxOutput;
}

function bundle(assets: readonly { unit: string; quantity: string | bigint }[]): string {
  return [...assets]
    .map((a) => `${a.unit}=${a.quantity.toString()}`)
    .sort()
    .join(",");
}

/** A decoded output's value, lovelace included, in the planner's shape. */
function outputBundle(output: DecodedTxOutput): string {
  return bundle([{ unit: LOVELACE, quantity: output.lovelace }, ...output.assets]);
}

/** Group amounts by recipient in first-seen order. */
function byRecipient<T>(rowsIn: readonly T[], address: (r: T) => string, amount: (r: T) => { unit: string; quantity: bigint }) {
  const groups = new Map<string, { unit: string; quantity: bigint }[]>();
  for (const r of rowsIn) {
    const list = groups.get(address(r)) ?? [];
    list.push(amount(r));
    groups.set(address(r), list);
  }
  return groups;
}

/**
 * The leaving outputs must be exactly one per recipient, each carrying what
 * the planner makes of that recipient's rows.
 */
function compareOutputs(leaving: readonly Leaving[], expected: Map<string, { unit: string; quantity: bigint }[]>, problems: string[]) {
  const planned = new Map<string, string>();
  try {
    for (const o of planOutputs([...expected.entries()].map(([address, amounts]) => ({ address, amounts }))).outputs) {
      planned.set(o.address, bundle(o.assets));
    }
  } catch (err) {
    problems.push(`The stored rows cannot be turned into outputs: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const seen = new Set<string>();
  for (const { index, output } of leaving) {
    const want = planned.get(output.address);
    if (want === undefined) {
      problems.push(`Output ${index} pays ${output.address}, which the stored rows do not name`);
      continue;
    }
    if (seen.has(output.address)) {
      problems.push(`Output ${index} pays ${output.address} a second time`);
      continue;
    }
    seen.add(output.address);
    if (outputBundle(output) !== want) {
      problems.push(`Output ${index} to ${output.address} does not carry what the stored rows say`);
    }
  }
  for (const address of planned.keys()) {
    if (!seen.has(address)) problems.push(`No output pays ${address}, which the stored rows name`);
  }
}

function comparePayoutRecord(meta: PayoutMetadata | null, input: CompareInput, problems: string[]) {
  if (!meta) {
    problems.push("The transaction carries no Treasury Guild payout record");
    return;
  }
  const tasksByWallet = new Map<string, Set<number>>();
  for (const p of input.payouts) {
    const set = tasksByWallet.get(p.contributorWallet) ?? new Set<number>();
    set.add(p.taskNumber);
    tasksByWallet.set(p.contributorWallet, set);
  }
  const named = new Set<string>();
  for (const [outputIndex, tasks] of meta.p) {
    const output = input.outputs[outputIndex];
    if (!output || output.address === input.treasuryAddress) {
      problems.push(`The record names output ${outputIndex}, which pays nobody`);
      continue;
    }
    const want = tasksByWallet.get(output.address);
    const got = new Set(tasks.map((t) => t[0]));
    if (!want || want.size !== got.size || [...want].some((n) => !got.has(n))) {
      problems.push(`The record's tasks for output ${outputIndex} differ from the stored payouts`);
    }
    named.add(output.address);
  }
  for (const wallet of tasksByWallet.keys()) {
    if (!named.has(wallet)) problems.push(`The record names no output for ${wallet}`);
  }
}

function comparePaymentRecord(meta: PaymentMetadata | null, input: CompareInput, problems: string[]) {
  if (!meta) {
    problems.push("The transaction carries no Treasury Guild payment record");
    return;
  }
  const transferByWallet = new Map<string, boolean>();
  for (const p of input.payments) transferByWallet.set(p.recipientWallet, p.recipientTreasuryId !== null);
  const named = new Set<string>();
  for (const [outputIndex, , flag] of meta.o) {
    const output = input.outputs[outputIndex];
    if (!output || output.address === input.treasuryAddress) {
      problems.push(`The record names output ${outputIndex}, which pays nobody`);
      continue;
    }
    const transfer = transferByWallet.get(output.address);
    if (transfer === undefined) {
      problems.push(`The record names output ${outputIndex}, which the stored payments do not`);
      continue;
    }
    if ((flag === 1) !== transfer) problems.push(`Output ${outputIndex} is ${transfer ? "" : "not "}a transfer in the stored payments but ${flag === 1 ? "" : "not "}in the record`);
    named.add(output.address);
  }
  for (const wallet of transferByWallet.keys()) {
    if (!named.has(wallet)) problems.push(`The record names no output for ${wallet}`);
  }
}

function compareMint(input: CompareInput, leaving: readonly Leaving[], problems: string[]) {
  if (input.mints.length === 0) {
    problems.push("No minted assets are stored for this transaction");
    return;
  }
  const recipients = new Set(input.mints.map((m) => m.recipient));
  if (recipients.size !== 1) problems.push("The stored mints name more than one recipient");
  const expectedMint = bundle(input.mints.map((m) => ({ unit: m.policyId + m.assetNameHex, quantity: m.quantity })));
  if (bundle(input.mint) !== expectedMint) problems.push("The transaction forges other assets than the stored mints");
  const nameBytes = input.mints.reduce((sum, m) => sum + m.assetNameHex.length / 2, 0);
  const minLovelace = minLovelaceForOutput({ policies: 1, assets: input.mints.length, totalNameBytes: nameBytes });
  const expectedOutput = bundle([
    { unit: LOVELACE, quantity: minLovelace },
    ...input.mints.map((m) => ({ unit: m.policyId + m.assetNameHex, quantity: m.quantity })),
  ]);
  const [recipient] = recipients;
  if (leaving.length !== 1) {
    problems.push(`A mint sends one output to its recipient; this transaction sends ${leaving.length}`);
    return;
  }
  const { index, output } = leaving[0]!;
  if (output.address !== recipient) problems.push(`Output ${index} pays ${output.address}, not the mint's recipient`);
  else if (outputBundle(output) !== expectedOutput) problems.push(`Output ${index} carries more than the minted assets and their minimum lovelace`);
}

/** Every way the transaction differs from its stored rows; empty when it matches. */
export function compareTxToRows(input: CompareInput): string[] {
  const problems: string[] = [];
  const leaving: Leaving[] = input.outputs
    .map((output, index) => ({ index, output }))
    .filter(({ output }) => output.address !== input.treasuryAddress);

  switch (input.kind) {
    case TxKind.Payout: {
      if (input.payouts.length === 0) problems.push("No payouts are stored for this transaction");
      if (input.mint.length > 0) problems.push("A payout forges no assets");
      compareOutputs(
        leaving,
        byRecipient(input.payouts, (p) => p.contributorWallet, (p) => ({ unit: p.unit, quantity: BigInt(p.amount) })),
        problems,
      );
      comparePayoutRecord(parsePayoutMetadata(input.payoutMeta), input, problems);
      break;
    }
    case TxKind.Payment: {
      if (input.payments.length === 0) problems.push("No payments are stored for this transaction");
      if (input.mint.length > 0) problems.push("A payment forges no assets");
      for (const p of input.payments) {
        if (p.recipientTreasuryId !== null && !input.siblingAddresses.has(p.recipientWallet)) {
          problems.push(`The transfer to ${p.recipientWallet} does not go to a treasury of this community`);
        }
      }
      compareOutputs(
        leaving,
        byRecipient(input.payments, (p) => p.recipientWallet, (p) => ({ unit: p.unit, quantity: BigInt(p.amount) })),
        problems,
      );
      comparePaymentRecord(parsePaymentMetadata(input.payoutMeta), input, problems);
      break;
    }
    case TxKind.Anchor: {
      if (leaving.length > 0) problems.push(`An anchor moves no funds; this transaction has ${leaving.length} output(s) leaving the treasury`);
      if (input.mint.length > 0) problems.push("An anchor forges no assets");
      break;
    }
    case TxKind.Mint: {
      compareMint(input, leaving, problems);
      break;
    }
    default:
      problems.push(`Unknown transaction kind "${input.kind}"`);
  }
  return [...new Set(problems)];
}
