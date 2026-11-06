// Match planned previous-wallet rows against chain tx_info-shaped data. Pure.
import { LegacyIssueCode as Code } from "@/lib/constants";
import { joinUnit } from "@/lib/cardano/units";
import type { LegacyIssue } from "./types";

export interface ChainTxOutput {
  txIndex: number;
  address: string;
  amounts: Record<string, string>;
}

export interface ChainTxInfo {
  txHash: string;
  blockTime: number;
  inputAddresses: string[];
  outputs: ChainTxOutput[];
}

/** Minimal Koios tx_info row shape for conversion (no server-only import). */
export interface KoiosTxInfoLike {
  tx_hash: string;
  tx_timestamp: number;
  inputs: { payment_addr: { bech32: string } }[];
  outputs: {
    payment_addr: { bech32: string };
    value: string;
    tx_index?: number;
    asset_list?: { policy_id: string; asset_name: string | null; quantity: string }[] | null;
  }[];
}

export interface PaymentChainClaim {
  line: number;
  txHash: string;
  outputIndex: number | null | undefined;
  recipientAddress: string;
  amounts: { unit: string; quantity: string }[];
  taskNormalized?: string;
}

export interface ReceiptChainClaim {
  line: number;
  txHash: string;
  outputIndex: number | null | undefined;
  amounts: { unit: string; quantity: string }[];
  csvDay?: string;
}

const TX_HASH_RE = /^[0-9a-f]{64}$/;

export function groupKey(txHash: string, outputIndex: number): string {
  return `${txHash.toLowerCase()}:${outputIndex}`;
}

export function chainDay(blockTime: number): string {
  return new Date(blockTime * 1000).toISOString().slice(0, 10);
}

export function datesAgree(csvDay: string, blockTime: number): boolean {
  return csvDay === chainDay(blockTime);
}

function outputAmountsFromKoios(output: KoiosTxInfoLike["outputs"][number]): Record<string, string> {
  const amounts: Record<string, string> = { lovelace: output.value };
  for (const asset of output.asset_list ?? []) {
    amounts[joinUnit(asset.policy_id, asset.asset_name)] = asset.quantity;
  }
  return amounts;
}

export function chainTxFromKoios(info: KoiosTxInfoLike): ChainTxInfo {
  return {
    txHash: info.tx_hash.toLowerCase(),
    blockTime: info.tx_timestamp,
    inputAddresses: info.inputs.map((i) => i.payment_addr.bech32.toLowerCase()),
    outputs: info.outputs.map((o, i) => ({
      txIndex: o.tx_index ?? i,
      address: o.payment_addr.bech32.toLowerCase(),
      amounts: outputAmountsFromKoios(o),
    })),
  };
}

function getTx(
  txs: Map<string, ChainTxInfo> | Record<string, ChainTxInfo>,
  hash: string,
): ChainTxInfo | undefined {
  if (txs instanceof Map) return txs.get(hash);
  return txs[hash];
}

function sumUnits(rows: { amounts: { unit: string; quantity: string }[] }[]): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const row of rows) {
    for (const { unit, quantity } of row.amounts) {
      out[unit] = (out[unit] ?? 0n) + BigInt(quantity);
    }
  }
  return out;
}

export function sumClaimsFitsOutput(
  claimedByUnit: Record<string, string>,
  alreadyByUnit: Record<string, string>,
  outputAmounts: Record<string, string>,
): boolean {
  const units = new Set([
    ...Object.keys(claimedByUnit),
    ...Object.keys(alreadyByUnit),
  ]);
  for (const unit of units) {
    const sum = BigInt(claimedByUnit[unit] ?? "0") + BigInt(alreadyByUnit[unit] ?? "0");
    const output = BigInt(outputAmounts[unit] ?? "0");
    if (sum > output) return false;
  }
  return true;
}

function lineIssue(line: number, code: LegacyIssue["code"], extra: Partial<LegacyIssue> = {}): LegacyIssue {
  return { code, line, severity: "error", ...extra };
}

function validateClaimIds(
  claim: { line: number; txHash: string; outputIndex: number | null | undefined },
  issues: LegacyIssue[],
): { txHash: string; outputIndex: number } | null {
  const rawHash = claim.txHash?.trim() ?? "";
  if (!rawHash) {
    issues.push(lineIssue(claim.line, Code.MissingTxHash));
    return null;
  }
  const txHash = rawHash.toLowerCase();
  if (!TX_HASH_RE.test(txHash)) {
    issues.push(lineIssue(claim.line, Code.BadTxHash, { value: rawHash }));
    return null;
  }
  if (claim.outputIndex === null || claim.outputIndex === undefined) {
    issues.push(lineIssue(claim.line, Code.MissingOutputIndex));
    return null;
  }
  if (!Number.isInteger(claim.outputIndex) || claim.outputIndex < 0) {
    issues.push(lineIssue(claim.line, Code.BadOutputIndex, { value: String(claim.outputIndex) }));
    return null;
  }
  return { txHash, outputIndex: claim.outputIndex };
}

function findOutput(tx: ChainTxInfo, outputIndex: number): ChainTxOutput | undefined {
  return tx.outputs.find((o) => o.txIndex === outputIndex);
}

function checkAmounts(
  group: { line: number; amounts: { unit: string; quantity: string }[] }[],
  key: string,
  output: ChainTxOutput,
  alreadyClaimed: Map<string, Record<string, string>> | Record<string, Record<string, string>>,
  issues: LegacyIssue[],
): void {
  const claimed = sumUnits(group);
  const alreadyRaw = alreadyClaimed instanceof Map ? alreadyClaimed.get(key) : alreadyClaimed[key];
  const already: Record<string, string> = alreadyRaw ?? {};
  const claimedStr: Record<string, string> = {};
  for (const [unit, qty] of Object.entries(claimed)) claimedStr[unit] = qty.toString();
  if (!sumClaimsFitsOutput(claimedStr, already, output.amounts)) {
    for (const c of group) issues.push(lineIssue(c.line, Code.AmountExceedsOutput));
  }
}

function duplicateTasks(
  group: PaymentChainClaim[],
  issues: LegacyIssue[],
): void {
  const seen = new Map<string, number>();
  for (const c of group) {
    if (c.taskNormalized === undefined) continue;
    const earlier = seen.get(c.taskNormalized);
    if (earlier !== undefined) {
      issues.push({ code: Code.DuplicateInFile, line: c.line, severity: "warning", value: String(earlier) });
    } else {
      seen.set(c.taskNormalized, c.line);
    }
  }
}

export function matchPaymentClaims(
  previousWalletAddress: string,
  claims: PaymentChainClaim[],
  txs: Map<string, ChainTxInfo> | Record<string, ChainTxInfo>,
  alreadyClaimed: Map<string, Record<string, string>> | Record<string, Record<string, string>>,
): LegacyIssue[] {
  const issues: LegacyIssue[] = [];
  const wallet = previousWalletAddress.toLowerCase();
  const parsed: (PaymentChainClaim & { txHash: string; outputIndex: number })[] = [];

  for (const claim of claims) {
    const ids = validateClaimIds(claim, issues);
    if (!ids) continue;
    parsed.push({
      ...claim,
      txHash: ids.txHash,
      outputIndex: ids.outputIndex,
      recipientAddress: claim.recipientAddress.toLowerCase(),
    });
  }

  const groups = new Map<string, typeof parsed>();
  for (const c of parsed) {
    const key = groupKey(c.txHash, c.outputIndex);
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  for (const [key, group] of groups) {
    const recipients = new Set(group.map((g) => g.recipientAddress));
    if (recipients.size > 1) {
      for (const c of group) issues.push(lineIssue(c.line, Code.RecipientMismatch));
      continue;
    }

    const head = group[0];
    if (!head) continue;
    const tx = getTx(txs, head.txHash);
    if (!tx) {
      for (const c of group) issues.push(lineIssue(c.line, Code.TxNotFound, { value: head.txHash }));
      continue;
    }

    if (!tx.inputAddresses.includes(wallet)) {
      for (const c of group) issues.push(lineIssue(c.line, Code.WalletNotInput));
      continue;
    }

    const output = findOutput(tx, head.outputIndex);
    if (!output) {
      for (const c of group) issues.push(lineIssue(c.line, Code.OutputNotFound));
      continue;
    }

    if (output.address !== head.recipientAddress) {
      for (const c of group) issues.push(lineIssue(c.line, Code.RecipientMismatch));
      continue;
    }

    duplicateTasks(group, issues);
    checkAmounts(group, key, output, alreadyClaimed, issues);
  }

  return issues;
}

export function matchReceiptClaims(
  previousWalletAddress: string,
  claims: ReceiptChainClaim[],
  txs: Map<string, ChainTxInfo> | Record<string, ChainTxInfo>,
  alreadyClaimed: Map<string, Record<string, string>> | Record<string, Record<string, string>>,
): LegacyIssue[] {
  const issues: LegacyIssue[] = [];
  const wallet = previousWalletAddress.toLowerCase();
  const parsed: (ReceiptChainClaim & { txHash: string; outputIndex: number })[] = [];

  for (const claim of claims) {
    const ids = validateClaimIds(claim, issues);
    if (!ids) continue;
    parsed.push({ ...claim, txHash: ids.txHash, outputIndex: ids.outputIndex });
  }

  const groups = new Map<string, typeof parsed>();
  for (const c of parsed) {
    const key = groupKey(c.txHash, c.outputIndex);
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }

  for (const [key, group] of groups) {
    const head = group[0];
    if (!head) continue;
    const tx = getTx(txs, head.txHash);
    if (!tx) {
      for (const c of group) issues.push(lineIssue(c.line, Code.TxNotFound, { value: head.txHash }));
      continue;
    }

    const output = findOutput(tx, head.outputIndex);
    if (!output) {
      for (const c of group) issues.push(lineIssue(c.line, Code.OutputNotFound));
      continue;
    }

    if (output.address !== wallet) {
      for (const c of group) issues.push(lineIssue(c.line, Code.RecipientMismatch));
      continue;
    }

    checkAmounts(group, key, output, alreadyClaimed, issues);

    for (const c of group) {
      if (c.csvDay !== undefined && !datesAgree(c.csvDay, tx.blockTime)) {
        issues.push(lineIssue(c.line, Code.ChainDateMismatch, { value: c.csvDay }));
      }
    }
  }

  return issues;
}
