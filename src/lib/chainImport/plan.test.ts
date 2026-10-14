import { describe, expect, it } from "vitest";
import type { AssetDef } from "@/lib/assets";
import type { PayoutMetadata } from "@/lib/cardano/metadata";
import type { PaymentMetadata } from "@/lib/cardano/paymentMetadata";
import { ChainImportIssueCode as Code } from "@/lib/constants";
import {
  checkOutputAmounts,
  planPaymentImport,
  planPayoutImport,
  resolveNumber,
  resolveTickers,
  resolveWorkgroup,
  stubTaskTitle,
  type ImportExistingTask,
  type ImportOutput,
  type PaymentImportInput,
  type PayoutImportInput,
} from "./plan";
import { ImportTaskMode } from "./types";

const GVTT = `${"a".repeat(56)}47565454`;
const REGISTRY: AssetDef[] = [{ fieldName: "GVTT", unit: GVTT, decimals: 2 }];
const TREASURY = "addr_treasury";

function output(address: string, lovelace: bigint, tokens: Record<string, bigint> = {}): ImportOutput {
  return { address, lovelace, assets: new Map(Object.entries(tokens)) };
}

// Task 50 to alice; task 51 (two assignees) to alice and bob; change last.
const META: PayoutMetadata = {
  v: 3,
  src: "treasury-guild",
  c: "signius",
  w: ["Payout Runs"],
  b: ["2026-Q3"],
  k: ["GVTT", "ADA"],
  p: [
    [0, [[50, 0, 0, ["1"]], [51, 0, 0, ["2.5", "1.5"]]]],
    [1, [[51, 0, 0, ["2.5", "1.5"]]]],
  ],
};
const OUTPUTS = [
  output("addr_alice", 2_000_000n, { [GVTT]: 350n }),
  output("addr_bob", 1_500_000n, { [GVTT]: 250n }),
  output(TREASURY, 90_000_000n),
];

function payoutInput(overrides: Partial<PayoutImportInput> = {}): PayoutImportInput {
  return {
    meta: META,
    communitySlug: "signius",
    treasuryAddress: TREASURY,
    outputs: OUTPUTS,
    tickers: { registry: REGISTRY, mints: [], candidates: [] },
    workgroups: [{ id: "wg1", name: "Payout Runs", archivedAt: null }],
    aliases: new Map(),
    existingTasks: [],
    asNewNumbers: new Set(),
    ...overrides,
  };
}

function existing(overrides: Partial<ImportExistingTask> = {}): ImportExistingTask {
  return {
    id: "task-51",
    number: 51,
    title: "Write the docs",
    workgroupId: "wg1",
    payState: "payable",
    paidTxHash: null,
    archivedAt: null,
    amounts: { GVTT: "2.5", ADA: "1.5" },
    bountyLovelace: "1500000",
    wallets: ["addr_alice", "addr_bob"],
    ...overrides,
  };
}

function issueCodes(result: ReturnType<typeof planPayoutImport>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

describe("planPayoutImport", () => {
  it("creates one task per number, with every paid wallet as an assignee", () => {
    const result = planPayoutImport(payoutInput());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.rows.tasks).toEqual([
      {
        chainNumber: 50,
        mode: ImportTaskMode.Keep,
        taskId: null,
        workgroupId: "wg1",
        title: "Imported task #50",
        amounts: { GVTT: "1" },
        bountyLovelace: null,
        budgetMonth: "2026-07-01",
        wallets: ["addr_alice"],
      },
      {
        chainNumber: 51,
        mode: ImportTaskMode.Keep,
        taskId: null,
        workgroupId: "wg1",
        title: "Imported task #51",
        amounts: { GVTT: "2.5", ADA: "1.5" },
        bountyLovelace: "1500000",
        budgetMonth: "2026-07-01",
        wallets: ["addr_alice", "addr_bob"],
      },
    ]);
    // One payout row per (task, wallet, unit), in base units.
    expect(result.rows.payouts).toEqual([
      { chainNumber: 50, wallet: "addr_alice", unit: GVTT, amount: "100" },
      { chainNumber: 51, wallet: "addr_alice", unit: GVTT, amount: "250" },
      { chainNumber: 51, wallet: "addr_alice", unit: "lovelace", amount: "1500000" },
      { chainNumber: 51, wallet: "addr_bob", unit: GVTT, amount: "250" },
      { chainNumber: 51, wallet: "addr_bob", unit: "lovelace", amount: "1500000" },
    ]);
    expect(result.rows.contributors).toEqual(["addr_alice", "addr_bob"]);
    expect(result.rows.description).toBe("Payout: 2 tasks, 3 payments, 2 contributors (GVTT, ADA)");
    expect(result.rows.assets).toEqual([]);
  });

  it("settles a matching unpaid task instead of creating one", () => {
    const result = planPayoutImport(payoutInput({ existingTasks: [existing()] }));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.rows.tasks.map((t) => [t.chainNumber, t.mode, t.taskId])).toEqual([
      [50, ImportTaskMode.Keep, null],
      [51, ImportTaskMode.Settle, "task-51"],
    ]);
  });

  it("holds a number that belongs to a different task, until an admin picks a new number", () => {
    const taken = [existing({ title: "Something else", amounts: { ADA: "9" }, bountyLovelace: "9000000" })];
    const held = planPayoutImport(payoutInput({ existingTasks: taken }));
    expect(issueCodes(held)).toEqual([Code.NumberConflict]);

    const asNew = planPayoutImport(payoutInput({ existingTasks: taken, asNewNumbers: new Set([51]) }));
    if (!asNew.ok) throw new Error(JSON.stringify(asNew.issues));
    expect(asNew.rows.tasks.find((t) => t.chainNumber === 51)?.mode).toBe(ImportTaskMode.New);
  });

  it("blocks the whole transaction and lists every issue", () => {
    const result = planPayoutImport(payoutInput({
      communitySlug: "other",
      workgroups: [],
      outputs: [OUTPUTS[0]!, output("addr_bob", 1_000_000n, { [GVTT]: 250n }), OUTPUTS[2]!],
    }));
    expect(issueCodes(result).sort()).toEqual(
      [Code.SlugMismatch, Code.WorkgroupMissing, Code.AmountMismatch].sort(),
    );
  });

  it("uses an admin's alias for a name no workgroup carries", () => {
    const result = planPayoutImport(payoutInput({
      workgroups: [{ id: "wg9", name: "Renamed", archivedAt: null }],
      aliases: new Map([["Payout Runs", "wg9"]]),
    }));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.rows.tasks.every((t) => t.workgroupId === "wg9")).toBe(true);
  });

  it("discovers a ticker from the transaction's own outputs and reports it", () => {
    const result = planPayoutImport(payoutInput({
      tickers: { registry: [], mints: [], candidates: [{ fieldName: "gvtt", unit: GVTT, decimals: 2 }] },
    }));
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.rows.assets).toEqual([{ fieldName: "GVTT", unit: GVTT, decimals: 2 }]);
  });

  it("stops at an unknown ticker: amounts cannot be read without decimals", () => {
    const result = planPayoutImport(payoutInput({ tickers: { registry: [], mints: [], candidates: [] } }));
    expect(issueCodes(result)).toEqual([Code.UnknownTicker]);
  });

  it("rejects a task whose copies differ, a missing output and a bad period", () => {
    const differs = planPayoutImport(payoutInput({
      meta: { ...META, p: [[0, [[51, 0, 0, ["2.5", "1.5"]]]], [1, [[51, 0, 0, ["2.5"]]]]] },
    }));
    expect(issueCodes(differs)).toContain(Code.BadMetadata);

    const missing = planPayoutImport(payoutInput({ meta: { ...META, p: [[7, [[50, 0, 0, ["1"]]]]] } }));
    expect(issueCodes(missing)).toContain(Code.OutputMissing);

    const period = planPayoutImport(payoutInput({ meta: { ...META, b: ["soon"] } }));
    expect(issueCodes(period)).toContain(Code.BadMetadata);
  });
});

describe("resolveNumber", () => {
  const want = {
    chainNumber: 51,
    workgroupId: "wg1",
    units: new Map([[GVTT, 250n], ["lovelace", 1_500_000n]]),
    wallets: ["addr_alice", "addr_bob"],
  };
  const reason = (task: ImportExistingTask) => {
    const r = resolveNumber(want, task, REGISTRY, false);
    return "issue" in r && r.issue.code === Code.NumberConflict ? r.issue.reason : null;
  };

  it("keeps a free number", () => {
    expect(resolveNumber(want, undefined, REGISTRY, false)).toEqual({ mode: ImportTaskMode.Keep, taskId: null });
  });

  it("settles only an exact match", () => {
    expect(resolveNumber(want, existing(), REGISTRY, false)).toEqual({ mode: ImportTaskMode.Settle, taskId: "task-51" });
    expect(reason(existing({ payState: "paid", paidTxHash: "f".repeat(64) }))).toMatch(/paid/);
    expect(reason(existing({ archivedAt: "2026-01-01T00:00:00Z" }))).toMatch(/archived/);
    expect(reason(existing({ workgroupId: "wg2" }))).toMatch(/another workgroup/);
    expect(reason(existing({ amounts: { GVTT: "2.5" }, bountyLovelace: null }))).toMatch(/amounts differ/);
    // Every assignee is paid, so one extra or one unlinked assignee is a different payment.
    expect(reason(existing({ wallets: ["addr_alice", "addr_bob", "addr_carol"] }))).toMatch(/assignees/);
    expect(reason(existing({ wallets: ["addr_alice", null] }))).toMatch(/assignees/);
    expect(reason(existing({ amounts: { DOGE: "1" } }))).toMatch(/compared/);
  });
});

describe("resolveWorkgroup", () => {
  const groups = [
    { id: "a", name: "Docs", archivedAt: null },
    { id: "b", name: "Twins", archivedAt: null },
    { id: "c", name: "Twins", archivedAt: null },
    { id: "d", name: "Old", archivedAt: "2026-01-01T00:00:00Z" },
    { id: "e", name: "x".repeat(70), archivedAt: null },
  ];
  const code = (name: string, aliases = new Map<string, string>()) => {
    const r = resolveWorkgroup(name, aliases, groups);
    return "issue" in r ? r.issue.code : r.workgroupId;
  };

  it("matches one active workgroup by its truncated name", () => {
    expect(code("Docs")).toBe("a");
    expect(code("x".repeat(64))).toBe("e");
  });

  it("names what is wrong otherwise", () => {
    expect(code("Nope")).toBe(Code.WorkgroupMissing);
    expect(code("Twins")).toBe(Code.WorkgroupAmbiguous);
    expect(code("Old")).toBe(Code.WorkgroupArchived);
  });

  it("lets an alias settle an ambiguous name, unless its target is archived", () => {
    expect(code("Twins", new Map([["Twins", "c"]]))).toBe("c");
    expect(code("Docs", new Map([["Docs", "d"]]))).toBe(Code.WorkgroupArchived);
  });
});

describe("resolveTickers", () => {
  it("prefers the registry, then mints, then the outputs' tokens; ADA is built in", () => {
    const other = `${"b".repeat(56)}47565454`;
    const r = resolveTickers(["ADA", "GVTT", "MINT", "SEEN"], {
      registry: REGISTRY,
      mints: [{ fieldName: "MINT", unit: other, decimals: 0 }, { fieldName: "GVTT", unit: other, decimals: 0 }],
      candidates: [{ fieldName: "Seen", unit: `${"c".repeat(56)}00`, decimals: 3 }],
    });
    expect(r.issues).toEqual([]);
    expect(r.assets.map((a) => a?.unit)).toEqual(["lovelace", GVTT, other, `${"c".repeat(56)}00`]);
    expect(r.discovered.map((a) => a.fieldName)).toEqual(["MINT", "SEEN"]);
  });

  it("refuses a ticker two different tokens claim", () => {
    const r = resolveTickers(["DUP"], {
      registry: [],
      mints: [],
      candidates: [
        { fieldName: "DUP", unit: `${"c".repeat(56)}01`, decimals: 0 },
        { fieldName: "DUP", unit: `${"c".repeat(56)}02`, decimals: 0 },
      ],
    });
    expect(r.issues).toEqual([{ code: Code.UnknownTicker, ticker: "DUP" }]);
  });
});

describe("checkOutputAmounts", () => {
  const expected = new Map([[GVTT, 100n], ["lovelace", 1_000_000n]]);
  const details = (o: ImportOutput) =>
    checkOutputAmounts(0, o, expected, TREASURY).map((i) => ("detail" in i ? i.detail : ""));

  it("accepts exact tokens and lovelace at or above the record (min-UTxO bump)", () => {
    expect(details(output("addr_a", 1_200_000n, { [GVTT]: 100n }))).toEqual([]);
  });

  it("rejects short lovelace, wrong tokens, unnamed tokens and the treasury's change", () => {
    expect(details(output("addr_a", 900_000n, { [GVTT]: 100n }))).toHaveLength(1);
    expect(details(output("addr_a", 1_000_000n, { [GVTT]: 99n }))).toHaveLength(1);
    expect(details(output("addr_a", 1_000_000n, { [GVTT]: 100n, [`${"d".repeat(56)}`]: 1n }))).toHaveLength(1);
    expect(details(output(TREASURY, 1_000_000n, { [GVTT]: 100n }))).toEqual(["the output is the treasury's own change"]);
  });
});

describe("planPaymentImport", () => {
  const PAYMENT: PaymentMetadata = {
    v: 1,
    src: "treasury-guild",
    t: "payment",
    c: "signius",
    b: "2026-09",
    k: ["ADA", "GVTT"],
    m: "Hosting",
    o: [[0, ["5"], 0], [1, ["", "10"], 1], [2, ["2"], 0]],
  };
  function paymentInput(overrides: Partial<PaymentImportInput> = {}): PaymentImportInput {
    return {
      meta: PAYMENT,
      communitySlug: "signius",
      treasuryAddress: TREASURY,
      outputs: [
        output("addr_host", 5_000_000n),
        output("addr_dev_treasury", 1_200_000n, { [GVTT]: 1000n }),
        output("addr_host", 2_000_000n),
        output(TREASURY, 50_000_000n),
      ],
      tickers: { registry: REGISTRY, mints: [], candidates: [] },
      siblings: [{ id: "t2", name: "Dev", address: "addr_dev_treasury" }],
      memberLabels: new Map([["addr_host", "@host"]]),
      ...overrides,
    };
  }

  it("writes one row per recipient and unit; a transfer carries no budget month", () => {
    const result = planPaymentImport(paymentInput());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.rows.payments).toEqual([
      { recipientWallet: "addr_host", recipientTreasuryId: null, label: "@host", unit: "lovelace", amount: "7000000", budgetMonth: "2026-09-01" },
      { recipientWallet: "addr_dev_treasury", recipientTreasuryId: "t2", label: "Dev", unit: GVTT, amount: "1000", budgetMonth: null },
    ]);
    expect(result.rows.description).toBe("Payment: Hosting, 2 recipients (ADA, GVTT)");
    expect(result.rows.tasks).toEqual([]);
    expect(result.rows.assets).toEqual([]);
  });

  it("holds a transfer to a treasury this database does not have, and an unmarked one", () => {
    const unknown = planPaymentImport(paymentInput({ siblings: [] }));
    expect(unknown.ok ? [] : unknown.issues.map((i) => i.code)).toEqual([Code.UnknownTreasury]);

    const unmarked = planPaymentImport(paymentInput({
      meta: { ...PAYMENT, o: [[0, ["5"], 0], [1, ["", "10"], 0], [2, ["2"], 0]] },
    }));
    expect(unmarked.ok ? [] : unmarked.issues.map((i) => i.code)).toEqual([Code.TransferMismatch]);
  });

  it("needs a budget period for spend", () => {
    const result = planPaymentImport(paymentInput({ meta: { ...PAYMENT, b: "" } }));
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual([Code.BadMetadata, Code.BadMetadata]);
  });
});

describe("stubTaskTitle", () => {
  it("names an import-created task after its chain number", () => {
    expect(stubTaskTitle(50)).toBe("Imported task #50");
    expect(stubTaskTitle(1)).toBe("Imported task #1");
    expect(stubTaskTitle(123456)).toBe("Imported task #123456");
  });

  it("is the title of every task a payout import plans, by the record's number", () => {
    const result = planPayoutImport(payoutInput());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.rows.tasks.length).toBeGreaterThan(0);
    for (const planned of result.rows.tasks) expect(planned.title).toBe(stubTaskTitle(planned.chainNumber));
    expect(result.rows.tasks.map((t) => t.title)).toEqual(["Imported task #50", "Imported task #51"]);
  });
});
