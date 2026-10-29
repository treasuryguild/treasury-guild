import { describe, expect, it } from "vitest";
import { LOVELACE } from "@/lib/assets";
import { buildPayoutMetadata } from "@/lib/cardano/metadata";
import { buildPaymentMetadata } from "@/lib/cardano/paymentMetadata";
import { planOutputs } from "@/lib/cardano/payoutOutputs";
import type { DecodedTxOutput } from "@/lib/cardano/types";
import { minLovelaceForOutput } from "@/lib/cardano/utxoSelect";
import { compareTxToRows, type CompareInput } from "./compare";

const TREASURY = "addr_test1treasury";
const SIBLING = "addr_test1sibling";
const ALICE = "addr_test1alice";
const BOB = "addr_test1bob";
const TOKEN = "p".repeat(56) + "48";

/** The outputs the builders make of these recipients, in the decoded shape. */
function outputsOf(recipients: { address: string; amounts: { unit: string; quantity: bigint }[] }[]): DecodedTxOutput[] {
  return planOutputs(recipients).outputs.map((o) => ({
    address: o.address,
    lovelace: o.assets.find((a) => a.unit === LOVELACE)!.quantity.toString(),
    assets: o.assets.filter((a) => a.unit !== LOVELACE).map((a) => ({ unit: a.unit, quantity: a.quantity.toString() })),
  }));
}
const change: DecodedTxOutput = { address: TREASURY, lovelace: "98765432", assets: [] };

const base: CompareInput = {
  kind: "payout", treasuryAddress: TREASURY, siblingAddresses: new Set([SIBLING]),
  outputs: [], mint: [], payoutMeta: null, payouts: [], payments: [], mints: [],
};

describe("compareTxToRows: payouts", () => {
  const payouts = [
    { taskNumber: 7, contributorWallet: ALICE, unit: LOVELACE, amount: "5000000" },
    { taskNumber: 7, contributorWallet: BOB, unit: LOVELACE, amount: "5000000" },
    { taskNumber: 9, contributorWallet: ALICE, unit: TOKEN, amount: "150" },
  ];
  const outputs = [
    ...outputsOf([
      { address: ALICE, amounts: [{ unit: LOVELACE, quantity: 5_000_000n }, { unit: TOKEN, quantity: 150n }] },
      { address: BOB, amounts: [{ unit: LOVELACE, quantity: 5_000_000n }] },
    ]),
    change,
  ];
  const meta = buildPayoutMetadata("guild", [
    { outputIndex: 0, taskNumber: 7, workgroupName: "Dev", budgetPeriod: "2026-10", amounts: [{ ticker: "ADA", decimals: 6, quantity: 5_000_000n }], citations: [] },
    { outputIndex: 0, taskNumber: 9, workgroupName: "Dev", budgetPeriod: "2026-10", amounts: [{ ticker: "HOSKY", decimals: 2, quantity: 150n }], citations: [] },
    { outputIndex: 1, taskNumber: 7, workgroupName: "Dev", budgetPeriod: "2026-10", amounts: [{ ticker: "ADA", decimals: 6, quantity: 5_000_000n }], citations: [] },
  ]);
  const input: CompareInput = { ...base, outputs, payoutMeta: meta, payouts };

  it("passes when the outputs and the record match the stored rows", () => {
    expect(compareTxToRows(input)).toEqual([]);
  });

  it("refuses an overpaid, extra, missing or redirected output", () => {
    const overpaid = outputs.map((o, i) => (i === 0 ? { ...o, lovelace: "6000000" } : o));
    expect(compareTxToRows({ ...input, outputs: overpaid })).toEqual([expect.stringMatching(/Output 0 to addr_test1alice does not carry/)]);
    const extra = [...outputs, { address: "addr_test1eve", lovelace: "1000000", assets: [] }];
    expect(compareTxToRows({ ...input, outputs: extra })).toEqual([expect.stringMatching(/Output 3 pays addr_test1eve, which the stored rows do not name/)]);
    const missing = [outputs[0]!, change];
    expect(compareTxToRows({ ...input, outputs: missing })).toEqual(expect.arrayContaining([
      expect.stringMatching(/No output pays addr_test1bob/),
      expect.stringMatching(/record names output 1, which pays nobody/),
    ]));
    const redirected = outputs.map((o, i) => (i === 1 ? { ...o, address: "addr_test1eve" } : o));
    expect(compareTxToRows({ ...input, outputs: redirected })).toEqual(expect.arrayContaining([
      expect.stringMatching(/Output 1 pays addr_test1eve/),
      expect.stringMatching(/No output pays addr_test1bob/),
    ]));
  });

  it("refuses a record that names other tasks, a missing record and a forged asset", () => {
    const otherTasks = buildPayoutMetadata("guild", [
      { outputIndex: 0, taskNumber: 8, workgroupName: "Dev", budgetPeriod: "2026-10", amounts: [{ ticker: "ADA", decimals: 6, quantity: 5_000_000n }], citations: [] },
      { outputIndex: 1, taskNumber: 7, workgroupName: "Dev", budgetPeriod: "2026-10", amounts: [{ ticker: "ADA", decimals: 6, quantity: 5_000_000n }], citations: [] },
    ]);
    expect(compareTxToRows({ ...input, payoutMeta: otherTasks })).toEqual([expect.stringMatching(/tasks for output 0 differ/)]);
    expect(compareTxToRows({ ...input, payoutMeta: null })).toEqual([expect.stringMatching(/carries no Treasury Guild payout record/)]);
    expect(compareTxToRows({ ...input, mint: [{ unit: TOKEN, policyId: "p".repeat(56), assetNameHex: "48", quantity: "1" }] }))
      .toEqual([expect.stringMatching(/payout forges no assets/)]);
    expect(compareTxToRows({ ...input, payouts: [] })).toEqual(expect.arrayContaining([expect.stringMatching(/No payouts are stored/)]));
  });
});

describe("compareTxToRows: payments", () => {
  const payments = [
    { recipientWallet: ALICE, recipientTreasuryId: null, unit: LOVELACE, amount: "2000000" },
    { recipientWallet: SIBLING, recipientTreasuryId: "t2", unit: LOVELACE, amount: "9000000" },
  ];
  const outputs = [
    ...outputsOf([
      { address: ALICE, amounts: [{ unit: LOVELACE, quantity: 2_000_000n }] },
      { address: SIBLING, amounts: [{ unit: LOVELACE, quantity: 9_000_000n }] },
    ]),
    change,
  ];
  const meta = buildPaymentMetadata("guild", "2026-10", null, [
    { outputIndex: 0, transfer: false, amounts: [{ ticker: "ADA", decimals: 6, quantity: 2_000_000n }] },
    { outputIndex: 1, transfer: true, amounts: [{ ticker: "ADA", decimals: 6, quantity: 9_000_000n }] },
  ]);
  const input: CompareInput = { ...base, kind: "payment", outputs, payoutMeta: meta, payments };

  it("passes a payment with a transfer to a sibling treasury", () => {
    expect(compareTxToRows(input)).toEqual([]);
  });

  it("refuses a transfer to a stranger, a swapped transfer flag and a missing record", () => {
    expect(compareTxToRows({ ...input, siblingAddresses: new Set() })).toEqual([expect.stringMatching(/transfer to addr_test1sibling does not go to a treasury/)]);
    const flipped = buildPaymentMetadata("guild", "2026-10", null, [
      { outputIndex: 0, transfer: true, amounts: [{ ticker: "ADA", decimals: 6, quantity: 2_000_000n }] },
      { outputIndex: 1, transfer: true, amounts: [{ ticker: "ADA", decimals: 6, quantity: 9_000_000n }] },
    ]);
    expect(compareTxToRows({ ...input, payoutMeta: flipped })).toEqual([expect.stringMatching(/Output 0 is not a transfer in the stored payments/)]);
    expect(compareTxToRows({ ...input, payoutMeta: null })).toEqual([expect.stringMatching(/carries no Treasury Guild payment record/)]);
  });
});

describe("compareTxToRows: anchors and mints", () => {
  it("lets an anchor through only with change and no mint", () => {
    expect(compareTxToRows({ ...base, kind: "anchor", outputs: [change] })).toEqual([]);
    expect(compareTxToRows({ ...base, kind: "anchor", outputs: [change, { address: ALICE, lovelace: "1000000", assets: [] }] }))
      .toEqual([expect.stringMatching(/anchor transaction moves no funds/i)]);
  });

  it("checks a mint forges exactly the stored assets to the stored recipient", () => {
    const policy = "q".repeat(56);
    const mints = [{ policyId: policy, assetNameHex: "4e4654", quantity: "1", recipient: ALICE }];
    const lovelace = minLovelaceForOutput({ policies: 1, assets: 1, totalNameBytes: 3 }).toString();
    const mint = [{ unit: policy + "4e4654", policyId: policy, assetNameHex: "4e4654", quantity: "1" }];
    const good: CompareInput = {
      ...base, kind: "mint", mints, mint,
      outputs: [{ address: ALICE, lovelace, assets: [{ unit: policy + "4e4654", quantity: "1" }] }, change],
    };
    expect(compareTxToRows(good)).toEqual([]);
    expect(compareTxToRows({ ...good, mint: [...mint, { unit: policy + "58", policyId: policy, assetNameHex: "58", quantity: "5" }] }))
      .toEqual([expect.stringMatching(/forges other assets/)]);
    expect(compareTxToRows({ ...good, outputs: [{ address: ALICE, lovelace: "50000000", assets: good.outputs[0]!.assets }, change] }))
      .toEqual([expect.stringMatching(/carries more than the minted assets/)]);
    expect(compareTxToRows({ ...good, outputs: [{ ...good.outputs[0]!, address: BOB }, change] })).toEqual([expect.stringMatching(/not the mint's recipient/)]);
    expect(compareTxToRows({ ...good, mints: [] })).toEqual([expect.stringMatching(/No minted assets are stored/)]);
  });

  it("refuses an unknown kind", () => {
    expect(compareTxToRows({ ...base, kind: "generic" })).toEqual([expect.stringMatching(/Unknown transaction kind/)]);
  });
});
