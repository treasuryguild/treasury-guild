import { describe, expect, it } from "vitest";
import {
  addressTail,
  alignedAmounts,
  assertPayoutMetadataFits,
  buildMessageMetadata,
  buildPayoutMetadata,
  byteLength,
  citedProposalNumbers,
  intern,
  internList,
  MAX_PAYOUT_METADATA_JSON_BYTES,
  metadataJsonBytes,
  parsePayoutMetadata,
  payoutMetadataJsonBytes,
  truncateUtf8,
  type PayoutForMetadata,
} from "./metadata";

describe("truncateUtf8", () => {
  it("keeps short strings", () => {
    expect(truncateUtf8("hello")).toBe("hello");
  });

  it("caps at 64 bytes without splitting code points", () => {
    const long = "é".repeat(100); // 2 bytes each
    const out = truncateUtf8(long);
    expect(byteLength(out)).toBeLessThanOrEqual(64);
    expect(out).toBe("é".repeat(32));
  });
});

const ADA = { ticker: "ADA", decimals: 6 };

function payout(overrides: Partial<PayoutForMetadata>): PayoutForMetadata {
  return {
    outputIndex: 0,
    taskNumber: 1,
    workgroupName: "Dev",
    budgetPeriod: "2026-09",
    amounts: [],
    ...overrides,
  };
}

describe("buildPayoutMetadata", () => {
  it("interns workgroups, periods and assets; tasks are positional tuples", () => {
    const meta = buildPayoutMetadata("my-dao", [
      payout({
        taskNumber: 42,
        amounts: [
          { ...ADA, quantity: 5_000_000n },
          { ticker: "AGIX", quantity: 1_000_000_000n, decimals: 8 },
        ],
      }),
      payout({
        taskNumber: 43,
        workgroupName: "Marketing",
        budgetPeriod: "2026-08",
        amounts: [
          { ticker: "AGIX", quantity: 500_000_000n, decimals: 8 },
          { ticker: "MINS", quantity: 30n, decimals: 0 },
        ],
      }),
      payout({ outputIndex: 1, taskNumber: 7, amounts: [{ ...ADA, quantity: 1_000_000n }] }),
      // A quarterly workgroup's task carries its quarter, not a month.
      payout({
        outputIndex: 1,
        taskNumber: 8,
        workgroupName: "Design",
        budgetPeriod: "2026-Q3",
        amounts: [{ ...ADA, quantity: 2_000_000n }],
      }),
    ]);
    expect(meta.v).toBe(3);
    expect(meta.src).toBe("treasury-guild");
    expect(meta.c).toBe("my-dao");
    expect("n" in meta).toBe(false);
    expect(meta.w).toEqual(["Dev", "Marketing", "Design"]);
    expect(meta.b).toEqual(["2026-09", "2026-08", "2026-Q3"]);
    expect(meta.k).toEqual(["ADA", "AGIX", "MINS"]);
    expect(meta.p).toEqual([
      [0, [
        [42, 0, 0, ["5", "10"]],
        [43, 1, 1, ["", "5", "30"]],
      ]],
      [1, [
        [7, 0, 0, ["1"]],
        [8, 2, 2, ["2"]],
      ]],
    ]);
  });

  it("scales exactly and trims trailing empty amounts", () => {
    const meta = buildPayoutMetadata("my-dao", [
      payout({
        amounts: [
          { ticker: "GVTT", quantity: 123_456_700n, decimals: 6 },
          { ticker: "RAW", quantity: 42n, decimals: 0 },
          { ticker: "TINY", quantity: 1n, decimals: 8 },
          { ...ADA, quantity: 1_500_000n },
        ],
      }),
      // pays only the first asset: no trailing "" placeholders
      payout({ taskNumber: 2, amounts: [{ ticker: "GVTT", quantity: 1_000_000n, decimals: 6 }] }),
      // pays only the last asset: leading "" placeholders keep alignment
      payout({ taskNumber: 3, amounts: [{ ...ADA, quantity: 2_000_000n }] }),
    ]);
    expect(meta.k).toEqual(["GVTT", "RAW", "TINY", "ADA"]);
    expect(meta.p[0]![1]).toEqual([
      [1, 0, 0, ["123.4567", "42", "0.00000001", "1.5"]],
      [2, 0, 0, ["1"]],
      [3, 0, 0, ["", "", "", "2"]],
    ]);
  });

  it("treats zero quantities as absent and never carries a handle or address", () => {
    const meta = buildPayoutMetadata("my-dao", [
      payout({ amounts: [{ ticker: "X", quantity: 0n, decimals: 0 }] }),
    ]);
    expect(meta.k).toEqual([]);
    expect(meta.p).toEqual([[0, [[1, 0, 0, []]]]]);
    const json = JSON.stringify(meta);
    expect(json).not.toContain('"h"');
    expect(json).not.toContain("addr");
  });

  it("orders entries by output index and interns in first-seen order", () => {
    const meta = buildPayoutMetadata("my-dao", [
      payout({ outputIndex: 2, taskNumber: 1, budgetPeriod: "2026-07" }),
      payout({ outputIndex: 0, taskNumber: 2, workgroupName: "Ops" }),
      payout({ outputIndex: 2, taskNumber: 3, budgetPeriod: "2026-07" }),
    ]);
    expect(meta.p.map(([o]) => o)).toEqual([0, 2]);
    expect(meta.p[1]![1].map(([i]) => i)).toEqual([1, 3]);
    expect(meta.w).toEqual(["Dev", "Ops"]);
    expect(meta.b).toEqual(["2026-07", "2026-09"]);
    expect(meta.p[1]![1].map(([, , b]) => b)).toEqual([0, 0]);
    expect(meta.p[0]![1][0]).toEqual([2, 1, 1, []]);
  });

  it("every string in the payload respects the 64-byte metadatum limit", () => {
    const meta = buildPayoutMetadata("x".repeat(200), [
      payout({
        workgroupName: "w".repeat(200),
        budgetPeriod: "b".repeat(200),
        amounts: [{ ticker: "T".repeat(200), quantity: 123456789012345n, decimals: 6 }],
      }),
    ]);
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [key, value] of Object.entries(v)) {
          strings.push(key);
          walk(value);
        }
      }
    };
    walk(meta);
    for (const s of strings) {
      expect(byteLength(s)).toBeLessThanOrEqual(64);
    }
  });
});

describe("assertPayoutMetadataFits", () => {
  it("accepts a typical payout", () => {
    const meta = buildPayoutMetadata("my-dao", [
      payout({ amounts: [{ ticker: "GVTT", quantity: 1n, decimals: 6 }] }),
    ]);
    expect(payoutMetadataJsonBytes(meta)).toBeLessThan(MAX_PAYOUT_METADATA_JSON_BYTES);
    expect(() => assertPayoutMetadataFits(meta)).not.toThrow();
  });

  it("rejects a payout whose metadata cannot fit in one transaction", () => {
    const many = Array.from({ length: 800 }, (_, i) =>
      payout({
        outputIndex: i % 50,
        taskNumber: i + 1,
        amounts: [
          { ...ADA, quantity: 1_234_567n },
          { ticker: "GVTT", quantity: 1_234_567_891n, decimals: 6 },
        ],
      }),
    );
    const meta = buildPayoutMetadata("my-dao", many);
    expect(() => assertPayoutMetadataFits(meta)).toThrow(/split it/);
  });
});

describe("buildMessageMetadata", () => {
  it("chunks at 63 chars", () => {
    const { msg } = buildMessageMetadata("a".repeat(130));
    expect(msg).toEqual(["a".repeat(63), "a".repeat(63), "a".repeat(4)]);
    for (const chunk of msg) {
      expect(byteLength(chunk)).toBeLessThanOrEqual(64);
    }
  });
});

describe("addressTail", () => {
  it("returns the last 6 chars", () => {
    expect(addressTail("addr_test1qp86rhgehcs4k99swgshl2")).toBe("wgshl2");
  });
});

const HASH = "ab".repeat(32);

describe("buildPayoutMetadata citations (g)", () => {
  const budget = { number: 3, contentHash: "cd".repeat(32) };
  const taskProposal = { number: 8, contentHash: HASH };

  it("lists each cited proposal once, by number, with the tasks citing it", () => {
    const meta = buildPayoutMetadata("signius", [
      payout({ outputIndex: 0, taskNumber: 50, amounts: [{ ...ADA, quantity: 1n }], citations: [taskProposal, budget] }),
      payout({ outputIndex: 1, taskNumber: 51, amounts: [{ ...ADA, quantity: 1n }], citations: [budget] }),
      // The same task paid to a second wallet: listed once.
      payout({ outputIndex: 2, taskNumber: 50, amounts: [{ ...ADA, quantity: 1n }], citations: [budget, taskProposal] }),
      payout({ outputIndex: 2, taskNumber: 52, amounts: [{ ...ADA, quantity: 1n }] }),
    ]);
    expect(meta.g).toEqual([[3, "cd".repeat(32), [50, 51]], [8, HASH, [50]]]);
    // Still v3, and the task entries keep their four elements.
    expect(meta.v).toBe(3);
    for (const [, tasks] of meta.p) for (const task of tasks) expect(task).toHaveLength(4);
  });

  it("omits g when nothing is cited", () => {
    const meta = buildPayoutMetadata("signius", [payout({ amounts: [{ ...ADA, quantity: 1n }], citations: [] })]);
    expect("g" in meta).toBe(false);
    expect(Object.keys(meta)).toEqual(["v", "src", "c", "w", "b", "k", "p"]);
  });
});

describe("parsePayoutMetadata", () => {
  const record = buildPayoutMetadata("signius", [
    {
      outputIndex: 0,
      taskNumber: 50,
      workgroupName: "Payout Runs",
      budgetPeriod: "2026-Q3",
      amounts: [{ ticker: "ADA", quantity: 5_000_000n, decimals: 6 }],
    },
  ]);
  const cited = buildPayoutMetadata("signius", [
    payout({ taskNumber: 50, amounts: [{ ...ADA, quantity: 5_000_000n }], citations: [{ number: 4, contentHash: HASH }] }),
  ]);

  it("reads back exactly what the builder writes (also after a JSON round trip)", () => {
    expect(parsePayoutMetadata(record)).toEqual(record);
    expect(parsePayoutMetadata(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(cited.g).toEqual([[4, HASH, [50]]]);
    expect(parsePayoutMetadata(JSON.parse(JSON.stringify(cited)))).toEqual(cited);
  });

  it("lists the cited numbers of any record for linking", () => {
    expect(citedProposalNumbers(cited)).toEqual([4]);
    expect(citedProposalNumbers({ g: [[9, HASH], [2, HASH, [1]], [9, HASH], ["x"]] })).toEqual([2, 9]);
    expect(citedProposalNumbers(record)).toEqual([]);
    expect(citedProposalNumbers(null)).toEqual([]);
  });

  it("is null when a citation is malformed", () => {
    expect(parsePayoutMetadata({ ...cited, g: [[4, HASH]] })).toBeNull();
    expect(parsePayoutMetadata({ ...cited, g: [[4, "x", [50]]] })).toBeNull();
    expect(parsePayoutMetadata({ ...cited, g: [[4, HASH, [0]]] })).toBeNull();
    expect(parsePayoutMetadata({ ...cited, g: {} })).toBeNull();
  });

  it("is null for anything that is not a complete v3 Treasury Guild payout", () => {
    expect(parsePayoutMetadata(null)).toBeNull();
    expect(parsePayoutMetadata({ ...record, v: 2 })).toBeNull();
    expect(parsePayoutMetadata({ ...record, src: "someone-else" })).toBeNull();
    expect(parsePayoutMetadata({ ...record, w: "Payout Runs" })).toBeNull();
    // An index outside its list, more amounts than tickers, a non-positive number.
    expect(parsePayoutMetadata({ ...record, p: [[0, [[50, 1, 0, ["5"]]]]] })).toBeNull();
    expect(parsePayoutMetadata({ ...record, p: [[0, [[50, 0, 0, ["5", "1"]]]]] })).toBeNull();
    expect(parsePayoutMetadata({ ...record, p: [[0, [[0, 0, 0, ["5"]]]]] })).toBeNull();
    // A huge chain number would overflow the next assign_task_number (integer).
    expect(parsePayoutMetadata({ ...record, p: [[0, [[2_147_483_647, 0, 0, ["5"]]]]] })).toBeNull();
    // A payment record shares the label but has no `p`.
    expect(parsePayoutMetadata({ v: 1, src: "treasury-guild", t: "payment", c: "signius", b: "", k: [], o: [] })).toBeNull();
  });
});

describe("internList / intern", () => {
  it("starts empty", () => {
    const list = internList();
    expect(list.values).toEqual([]);
    expect(list.index.size).toBe(0);
  });

  it("gives each new value the next index and a repeated value its first index", () => {
    const list = internList();
    expect(intern(list, "Dev")).toBe(0);
    expect(intern(list, "Marketing")).toBe(1);
    expect(intern(list, "Dev")).toBe(0);
    expect(intern(list, "Ops")).toBe(2);
    expect(intern(list, "Marketing")).toBe(1);
    expect(list.values).toEqual(["Dev", "Marketing", "Ops"]);
    // The returned index is the value's position in the emitted list.
    for (const [value, index] of list.index) expect(list.values[index]).toBe(value);
  });

  it("compares values exactly: case, whitespace and the empty string are distinct", () => {
    const list = internList();
    expect(["ADA", "ada", "ADA ", "", "ADA", ""].map((v) => intern(list, v))).toEqual([0, 1, 2, 3, 0, 3]);
    expect(list.values).toEqual(["ADA", "ada", "ADA ", ""]);
  });

  it("keeps separate lists separate", () => {
    const a = internList();
    const b = internList();
    intern(a, "x");
    expect(intern(b, "y")).toBe(0);
    expect(a.values).toEqual(["x"]);
    expect(b.values).toEqual(["y"]);
  });
});

describe("alignedAmounts", () => {
  const AGIX = { ticker: "AGIX", decimals: 8 };
  const MINS = { ticker: "MINS", decimals: 0 };
  /** A ticker list that already holds ADA, AGIX, MINS (as after earlier entries). */
  function seeded() {
    const tickers = internList();
    for (const t of ["ADA", "AGIX", "MINS"]) intern(tickers, t);
    return tickers;
  }

  it("scales each quantity exactly and interns new tickers in first-seen order", () => {
    const tickers = internList();
    expect(alignedAmounts([
      { ...ADA, quantity: 5_000_000n },
      { ...AGIX, quantity: 1_050_000_000n },
      { ...MINS, quantity: 30n },
    ], tickers)).toEqual(["5", "10.5", "30"]);
    expect(tickers.values).toEqual(["ADA", "AGIX", "MINS"]);
  });

  it("fills the gap before a later ticker with empty strings", () => {
    expect(alignedAmounts([{ ...MINS, quantity: 30n }], seeded())).toEqual(["", "", "30"]);
    expect(alignedAmounts([{ ...ADA, quantity: 5_000_000n }, { ...MINS, quantity: 30n }], seeded())).toEqual(["5", "", "30"]);
    expect(alignedAmounts([{ ...AGIX, quantity: 100_000_000n }], seeded())).toEqual(["", "1"]);
  });

  it("never emits a trailing empty string", () => {
    expect(alignedAmounts([{ ...ADA, quantity: 5_000_000n }], seeded())).toEqual(["5"]);
    expect(alignedAmounts([], seeded())).toEqual([]);
    for (const amounts of [[{ ...MINS, quantity: 1n }], [{ ...AGIX, quantity: 1n }, { ...ADA, quantity: 1n }]]) {
      const x = alignedAmounts(amounts, seeded());
      expect(x[x.length - 1]).not.toBe("");
    }
  });

  it("follows the list's order, not the order the amounts are given in", () => {
    expect(alignedAmounts([{ ...MINS, quantity: 30n }, { ...ADA, quantity: 5_000_000n }], seeded())).toEqual(["5", "", "30"]);
  });

  it("skips zero and negative quantities without interning their ticker", () => {
    const tickers = internList();
    expect(alignedAmounts([
      { ticker: "ZERO", quantity: 0n, decimals: 0 },
      { ticker: "NEG", quantity: -5n, decimals: 0 },
    ], tickers)).toEqual([]);
    expect(tickers.values).toEqual([]);
    // A skipped amount leaves no slot behind it either.
    expect(alignedAmounts([{ ...ADA, quantity: 0n }, { ...MINS, quantity: 30n }], tickers)).toEqual(["30"]);
    expect(tickers.values).toEqual(["MINS"]);
    expect(alignedAmounts([{ ...ADA, quantity: 1_000_000n }, { ...MINS, quantity: 0n }], seeded())).toEqual(["1"]);
  });

  it("sums a ticker given more than once as integers", () => {
    expect(alignedAmounts([
      { ...ADA, quantity: 1_500_000n },
      { ...AGIX, quantity: 1n },
      { ...ADA, quantity: 2_500_000n },
    ], internList())).toEqual(["4", "0.00000001"]);
    // Beyond 2^53, still exact.
    expect(alignedAmounts([
      { ...MINS, quantity: 9_007_199_254_740_993n },
      { ...MINS, quantity: 9_007_199_254_740_993n },
    ], internList())).toEqual(["18014398509481986"]);
  });

  it("scales with the first-seen decimals when a ticker's decimals disagree", () => {
    expect(alignedAmounts([
      { ticker: "ADA", quantity: 1_000_000n, decimals: 6 },
      { ticker: "ADA", quantity: 1_000_000n, decimals: 0 },
    ], internList())).toEqual(["2"]);
    expect(alignedAmounts([
      { ticker: "ADA", quantity: 1_000_000n, decimals: 0 },
      { ticker: "ADA", quantity: 1_000_000n, decimals: 6 },
    ], internList())).toEqual(["2000000"]);
    // A skipped zero amount does not count as first seen.
    expect(alignedAmounts([
      { ticker: "ADA", quantity: 0n, decimals: 0 },
      { ticker: "ADA", quantity: 1_500_000n, decimals: 6 },
    ], internList())).toEqual(["1.5"]);
  });

  it("caps a ticker at 32 bytes, merging tickers that share the capped form", () => {
    const tickers = internList();
    const long = "T".repeat(40);
    expect(alignedAmounts([
      { ticker: long, quantity: 1n, decimals: 0 },
      { ticker: `${"T".repeat(32)}other`, quantity: 2n, decimals: 0 },
    ], tickers)).toEqual(["3"]);
    expect(tickers.values).toEqual(["T".repeat(32)]);
    expect(byteLength(tickers.values[0]!)).toBe(32);
  });

  it("is what the payout builder writes for each task", () => {
    const amounts = [{ ...AGIX, quantity: 500_000_000n }, { ...MINS, quantity: 30n }];
    const meta = buildPayoutMetadata("my-dao", [
      payout({ taskNumber: 1, amounts: [{ ...ADA, quantity: 5_000_000n }] }),
      payout({ taskNumber: 2, amounts }),
    ]);
    const tickers = internList();
    intern(tickers, "ADA");
    expect(meta.p[0]![1][1]![3]).toEqual(alignedAmounts(amounts, tickers));
    expect(meta.k).toEqual(tickers.values);
  });
});

describe("metadataJsonBytes", () => {
  it("is the UTF-8 byte length of the JSON rendering, not its character count", () => {
    expect(metadataJsonBytes({})).toBe(2);
    expect(metadataJsonBytes({ a: "b" })).toBe('{"a":"b"}'.length);
    // "é" is one character and two bytes; an emoji is two UTF-16 units and four bytes.
    expect(metadataJsonBytes({ a: "é" })).toBe(10);
    expect(metadataJsonBytes({ a: "🚀" })).toBe(12);
    expect(metadataJsonBytes([1, "", ["x"]])).toBe('[1,"",["x"]]'.length);
  });

  it("measures a payout record the same as payoutMetadataJsonBytes and grows with every task", () => {
    const one = buildPayoutMetadata("my-dao", [payout({ amounts: [{ ...ADA, quantity: 5_000_000n }] })]);
    const two = buildPayoutMetadata("my-dao", [
      payout({ amounts: [{ ...ADA, quantity: 5_000_000n }] }),
      payout({ taskNumber: 2, amounts: [{ ...ADA, quantity: 5_000_000n }] }),
    ]);
    expect(metadataJsonBytes(one)).toBe(payoutMetadataJsonBytes(one));
    expect(metadataJsonBytes(one)).toBe(Buffer.byteLength(JSON.stringify(one), "utf8"));
    expect(metadataJsonBytes(two)).toBe(metadataJsonBytes(one) + ',[2,0,0,["5"]]'.length);
  });
});
