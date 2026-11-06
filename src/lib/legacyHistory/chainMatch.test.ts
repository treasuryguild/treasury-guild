import { describe, expect, it } from "vitest";
import { LegacyIssueCode as Code } from "@/lib/constants";
import {
  chainDay, datesAgree, groupKey, matchPaymentClaims, matchReceiptClaims, sumClaimsFitsOutput,
  type ChainTxInfo,
} from "./chainMatch";

const WALLET = "addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const RECIPIENT = "addr_test1rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr";
const HASH = "ab".repeat(32);

function tx(overrides: Partial<ChainTxInfo> = {}): ChainTxInfo {
  return {
    txHash: HASH,
    blockTime: 1_700_000_000,
    inputAddresses: [WALLET],
    outputs: [{
      txIndex: 0,
      address: RECIPIENT,
      amounts: { lovelace: "2000000" },
    }],
    ...overrides,
  };
}

describe("chainDay and datesAgree", () => {
  it("uses UTC calendar day from unix seconds", () => {
    expect(chainDay(1_704_067_200)).toBe("2024-01-01");
    expect(datesAgree("2024-01-01", 1_704_067_200)).toBe(true);
    expect(datesAgree("2024-01-02", 1_704_067_200)).toBe(false);
  });
});

describe("sumClaimsFitsOutput", () => {
  it("allows partial lovelace and rejects over-claim", () => {
    const output = { lovelace: "2000000" };
    expect(sumClaimsFitsOutput({ lovelace: "1500000" }, {}, output)).toBe(true);
    expect(sumClaimsFitsOutput({ lovelace: "2000001" }, {}, output)).toBe(false);
    expect(sumClaimsFitsOutput({ lovelace: "1000000" }, { lovelace: "1000000" }, output)).toBe(true);
    expect(sumClaimsFitsOutput({ lovelace: "1000000" }, { lovelace: "1000001" }, output)).toBe(false);
  });
});

describe("matchPaymentClaims", () => {
  const txs = { [HASH]: tx() };

  it("accepts multiple tasks on the same output when amounts sum within the output", () => {
    const issues = matchPaymentClaims(WALLET, [
      { line: 2, txHash: HASH, outputIndex: 0, recipientAddress: RECIPIENT, amounts: [{ unit: "lovelace", quantity: "1000000" }], taskNormalized: "task-a" },
      { line: 3, txHash: HASH, outputIndex: 0, recipientAddress: RECIPIENT, amounts: [{ unit: "lovelace", quantity: "500000" }], taskNormalized: "task-b" },
    ], txs, new Map());
    expect(issues).toEqual([]);
  });

  it("flags duplicate normalized task on the same output", () => {
    const issues = matchPaymentClaims(WALLET, [
      { line: 2, txHash: HASH, outputIndex: 0, recipientAddress: RECIPIENT, amounts: [{ unit: "lovelace", quantity: "1000000" }], taskNormalized: "same" },
      { line: 4, txHash: HASH, outputIndex: 0, recipientAddress: RECIPIENT, amounts: [{ unit: "lovelace", quantity: "500000" }], taskNormalized: "same" },
    ], txs, new Map());
    expect(issues).toEqual([{ code: Code.DuplicateInFile, line: 4, severity: "warning", value: "2" }]);
  });

  it("rejects over-claim on lovelace", () => {
    const issues = matchPaymentClaims(WALLET, [
      { line: 2, txHash: HASH, outputIndex: 0, recipientAddress: RECIPIENT, amounts: [{ unit: "lovelace", quantity: "1500000" }] },
      { line: 3, txHash: HASH, outputIndex: 0, recipientAddress: RECIPIENT, amounts: [{ unit: "lovelace", quantity: "600000" }] },
    ], txs, new Map());
    expect(issues.some((i) => i.code === Code.AmountExceedsOutput)).toBe(true);
  });

  it("rejects wrong recipient", () => {
    const issues = matchPaymentClaims(WALLET, [
      { line: 2, txHash: HASH, outputIndex: 0, recipientAddress: WALLET, amounts: [{ unit: "lovelace", quantity: "1000000" }] },
    ], txs, new Map());
    expect(issues).toEqual([{ code: Code.RecipientMismatch, line: 2, severity: "error" }]);
  });

  it("rejects when the previous wallet is not an input", () => {
    const issues = matchPaymentClaims(WALLET, [
      { line: 2, txHash: HASH, outputIndex: 0, recipientAddress: RECIPIENT, amounts: [{ unit: "lovelace", quantity: "1000000" }] },
    ], { [HASH]: tx({ inputAddresses: ["addr_test1other"] }) }, new Map());
    expect(issues).toEqual([{ code: Code.WalletNotInput, line: 2, severity: "error" }]);
  });

  it("rejects missing transaction", () => {
    const issues = matchPaymentClaims(WALLET, [
      { line: 2, txHash: HASH, outputIndex: 0, recipientAddress: RECIPIENT, amounts: [{ unit: "lovelace", quantity: "1000000" }] },
    ], {}, new Map());
    expect(issues).toEqual([{ code: Code.TxNotFound, line: 2, severity: "error", value: HASH }]);
  });

  it("groups by groupKey", () => {
    expect(groupKey(HASH, 3)).toBe(`${HASH}:3`);
  });
});

describe("matchReceiptClaims", () => {
  it("requires the named output to pay the previous wallet and checks dates", () => {
    const blockTime = 1_704_067_200;
    const txs = {
      [HASH]: tx({
        blockTime,
        inputAddresses: ["addr_test1spender"],
        outputs: [{ txIndex: 1, address: WALLET, amounts: { lovelace: "5000000" } }],
      }),
    };
    const ok = matchReceiptClaims(WALLET, [
      { line: 2, txHash: HASH, outputIndex: 1, amounts: [{ unit: "lovelace", quantity: "5000000" }], csvDay: "2024-01-01" },
    ], txs, new Map());
    expect(ok).toEqual([]);

    const badDate = matchReceiptClaims(WALLET, [
      { line: 3, txHash: HASH, outputIndex: 1, amounts: [{ unit: "lovelace", quantity: "1000000" }], csvDay: "2024-01-02" },
    ], txs, new Map());
    expect(badDate).toEqual([{ code: Code.ChainDateMismatch, line: 3, severity: "error", value: "2024-01-02" }]);
  });
});
