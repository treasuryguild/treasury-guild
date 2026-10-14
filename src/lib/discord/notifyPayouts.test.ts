import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbClient from "@/lib/db/client";
import { unitDisplayFromRegistry } from "@/lib/assetRegistry";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  registry: vi.fn(),
  mintHints: vi.fn(),
  budgets: vi.fn(),
  wallet: vi.fn(),
  rate: vi.fn(),
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof DbClient>()),
  serviceClient: () => ({ from: mocks.from }),
  rows: (res: { data: unknown; error: unknown }, what: string) => {
    if (res.error) throw new Error(what);
    return res.data ?? [];
  },
  check: (res: { error: unknown }, what: string) => {
    if (res.error) throw new Error(what);
  },
}));
vi.mock("@/lib/db/assets", () => ({
  loadAssetRegistry: mocks.registry,
  loadMintAssetHints: mocks.mintHints,
}));
vi.mock("@/lib/db/budgetDashboard", () => ({ loadWorkgroupBudgets: mocks.budgets }));
vi.mock("@/lib/cardano/walletAssets", () => ({ fetchWalletAssets: mocks.wallet }));
vi.mock("@/lib/rates/coingecko", () => ({ fetchExchangeRate: mocks.rate }));

import { budgetLinesFrom, groupPayoutLines, notifyConfirmedPayouts } from "./notifyPayouts";

const HASH = "cd".repeat(32);
const GVT = "a".repeat(56) + "475654";
const AT = new Date("2026-09-15T12:00:00Z");

interface Op {
  table: string;
  op: "select" | "update";
  values?: Record<string, unknown>;
  filters: [string, unknown][];
}
let ops: Op[];
let pendingTxs: unknown[];
let payoutLines: unknown[];

/** Minimal thenable query builder recording what the stage asks for. */
function builder(table: string) {
  const op: Op = { table, op: "select", filters: [] };
  const respond = () => {
    if (op.op === "update") return { data: null, error: null };
    if (table === "transactions") return { data: pendingTxs, error: null };
    if (table === "payouts") return { data: payoutLines, error: null };
    return { data: [], error: null };
  };
  const chain = {
    select: () => chain,
    update: (values: Record<string, unknown>) => {
      op.op = "update";
      op.values = values;
      return chain;
    },
    eq: (k: string, v: unknown) => {
      op.filters.push([k, v]);
      return chain;
    },
    is: (k: string, v: unknown) => {
      op.filters.push([k, v]);
      return chain;
    },
    limit: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      ops.push(op);
      return Promise.resolve(respond()).then(resolve, reject);
    },
  };
  return chain;
}

const tx = {
  id: "tx-1",
  tx_hash: HASH,
  treasury_id: "t-1",
  treasuries: {
    name: "Main",
    address: "addr_test1treasury",
    network: 0,
    community_id: "c-1",
    treasury_discord_webhooks: { url: "https://discord.com/api/webhooks/1/tok" },
    communities: { slug: "guild", name: "Guild DAO", discord_rate_coin: "cardano", discord_rate_currency: "usd" },
  },
};

const line = (over: Record<string, unknown>) => ({
  task_id: "task-1",
  contributor_wallet: "addr1alice000000",
  unit: "lovelace",
  amount: "150000000",
  tasks: { workgroup_id: "wg-dev", workgroups: { name: "Dev" } },
  ...over,
});

const updates = (table: string) => ops.filter((o) => o.table === table && o.op === "update");

interface SentEmbed {
  author: { name: string; url: string; icon_url: string };
  description: string;
  fields: { name: string; value: string }[];
  footer: { text: string };
}

function sentEmbed(fetchImpl: ReturnType<typeof vi.fn>): SentEmbed {
  const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  return (JSON.parse(String(init.body)) as { embeds: SentEmbed[] }).embeds[0]!;
}

beforeEach(() => {
  vi.resetAllMocks();
  ops = [];
  pendingTxs = [tx];
  payoutLines = [line({})];
  mocks.from.mockImplementation(builder);
  mocks.registry.mockResolvedValue([{ fieldName: "GVT", unit: GVT, decimals: 2 }]);
  mocks.mintHints.mockResolvedValue(new Map());
  mocks.budgets.mockResolvedValue([
    {
      ownerType: "workgroup",
      ownerId: "wg-dev",
      ownerName: "Dev",
      periodLabel: "September 2026",
      assetLabel: "ADA",
      decimals: 6,
      amount: "3000000000",
      spent: "450000000",
    },
  ]);
  mocks.wallet.mockResolvedValue({
    lovelace: 9_000_000_000n,
    utxoCount: 3,
    tokens: [{ unit: GVT, quantity: 12_345n, ticker: null, name: null, decimals: 0, source: "none" }],
  });
  mocks.rate.mockResolvedValue({ price: 0.42, currency: "usd", symbol: "ADA" });
  delete process.env.APP_URL;
});

describe("groupPayoutLines", () => {
  it("takes amounts from one wallet's rows and lists distinct recipients per task", () => {
    const display = unitDisplayFromRegistry([{ fieldName: "GVT", unit: GVT, decimals: 2 }]);
    const tasks = groupPayoutLines(
      [
        line({}),
        line({ unit: GVT, amount: "25000" }),
        line({ contributor_wallet: "addr1bob0000a4f9" }),
        line({ contributor_wallet: "addr1bob0000a4f9", unit: GVT, amount: "25000" }),
        line({ task_id: "task-2", tasks: { workgroup_id: "wg-ops", workgroups: { name: "Ops" } } }),
      ] as Parameters<typeof groupPayoutLines>[0],
      display,
    );
    expect(tasks).toEqual([
      {
        workgroupId: "wg-dev",
        workgroupName: "Dev",
        amounts: [
          { ticker: "ADA", decimals: 6, quantity: 150_000_000n },
          { ticker: "GVT", decimals: 2, quantity: 25_000n },
        ],
        recipientWallets: ["addr1alice000000", "addr1bob0000a4f9"],
      },
      {
        workgroupId: "wg-ops",
        workgroupName: "Ops",
        amounts: [{ ticker: "ADA", decimals: 6, quantity: 150_000_000n }],
        recipientWallets: ["addr1alice000000"],
      },
    ]);
  });
});

describe("notifyConfirmedPayouts", () => {
  it("posts one embed per confirmed payout with budgets, balance, rate and links, then stamps it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const result = await notifyConfirmedPayouts({ fetchImpl, now: AT });

    expect(result).toEqual({ posted: 1, failed: 0, dead: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://discord.com/api/webhooks/1/tok");
    const embed = sentEmbed(fetchImpl);
    expect(embed.author).toEqual({
      name: "Guild DAO",
      url: "http://localhost:3000/c/guild",
      icon_url: "http://localhost:3000/logo-white.png",
    });
    expect(embed.description).toContain("[Transaction](http://localhost:3000/c/guild/tx/tx-1)");
    expect(embed.description).toContain("[Dashboard](http://localhost:3000/c/guild/dashboard)");
    const field = (name: string) => embed.fields.find((f) => f.name === name)?.value;
    expect(field("Spending by workgroup")).toBe("```css\nDev: 150 ADA\n```");
    expect(field("Budget balance")).toBe("```css\nDev — September 2026\n  2,550 / 3,000 ADA left\n```");
    // registry ticker wins for the token; the address link is the preprod explorer
    expect(field("Treasury balance")).toBe(
      "[Main on explorer](https://preprod.cexplorer.io/address/addr_test1treasury)\n```css\n9,000 ADA\n123.45 GVT\n```",
    );
    expect(embed.footer.text).toBe("Exchange rate — 0.42 USD per ADA — 15 Sep 2026");
    expect(mocks.budgets).toHaveBeenCalledWith("c-1", ["wg-dev"], AT);
    expect(mocks.rate).toHaveBeenCalledWith("cardano", "usd", fetchImpl);

    // only confirmed, unannounced payouts are loaded
    const load = ops.find((o) => o.table === "transactions" && o.op === "select")!;
    expect(load.filters).toEqual([
      ["state", 2],
      ["kind", "payout"],
      ["discord_notified_at", null],
    ]);
    expect(updates("transactions")[0]).toMatchObject({
      values: { discord_notified_at: expect.any(String) },
      filters: [["id", "tx-1"]],
    });
    expect(updates("treasury_discord_webhooks")[0]).toMatchObject({
      values: { last_posted_at: expect.any(String), last_error: null },
      filters: [["treasury_id", "t-1"]],
    });
  });

  it("still posts when budgets, balance or the rate cannot be loaded, and skips the rate when unset", async () => {
    pendingTxs = [{ ...tx, treasuries: { ...tx.treasuries, communities: { ...tx.treasuries.communities, discord_rate_coin: null } } }];
    mocks.budgets.mockRejectedValue(new Error("rpc down"));
    mocks.wallet.mockRejectedValue(new Error("koios down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    expect(await notifyConfirmedPayouts({ fetchImpl, now: AT })).toEqual({ posted: 1, failed: 0, dead: 0 });
    const embed = sentEmbed(fetchImpl);
    expect(embed.fields.map((f) => f.name)).not.toContain("Treasury balance");
    expect(embed.fields.find((f) => f.name === "Budget balance")?.value).toBe("```css\nDev — no budget\n```");
    expect(embed.footer.text).toBe("15 Sep 2026");
    expect(mocks.rate).not.toHaveBeenCalled();
  });

  it("leaves the tx unstamped after a transient failure so the next sweep retries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await notifyConfirmedPayouts({ fetchImpl, now: AT });
    expect(result).toEqual({ posted: 0, failed: 1, dead: 0 });
    expect(updates("transactions")).toHaveLength(0);
    expect(updates("treasury_discord_webhooks")).toHaveLength(0);
  });

  it("stamps the tx and records the error when the webhook is gone", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Unknown Webhook", { status: 404 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await notifyConfirmedPayouts({ fetchImpl, now: AT });
    expect(result).toEqual({ posted: 0, failed: 0, dead: 1 });
    expect(updates("transactions")).toHaveLength(1);
    expect(updates("treasury_discord_webhooks")[0]?.values).toEqual({
      last_error: "Discord webhook not found (deleted or wrong URL?): Unknown Webhook",
    });
  });

  it("does nothing when there is nothing to announce", async () => {
    pendingTxs = [];
    const fetchImpl = vi.fn();
    expect(await notifyConfirmedPayouts({ fetchImpl })).toEqual({ posted: 0, failed: 0, dead: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("budgetLinesFrom", () => {
  const summary = {
    ownerName: "Dev", periodLabel: "September 2026", assetLabel: "ADA", decimals: 6,
    amount: "3000000000", spent: "450000000",
  };

  it("narrows a budget summary to the line the embed shows, amounts as exact integers", () => {
    expect(budgetLinesFrom([summary])).toEqual([{
      workgroupName: "Dev", periodLabel: "September 2026", ticker: "ADA", decimals: 6,
      allocated: 3_000_000_000n, spent: 450_000_000n,
    }]);
  });

  it("drops every other field of the summary", () => {
    const wide = { ...summary, id: "b1", ownerId: "wg1", ownerType: "workgroup", unit: "lovelace", balance: "2550000000", cadence: "monthly" };
    expect(Object.keys(budgetLinesFrom([wide])[0]!).sort())
      .toEqual(["allocated", "decimals", "periodLabel", "spent", "ticker", "workgroupName"]);
  });

  it("keeps order, one line per summary, and amounts beyond 2^53", () => {
    const lines = budgetLinesFrom([
      summary,
      { ...summary, ownerName: "Design", assetLabel: "GVT", decimals: 2, amount: "9007199254740993", spent: "9007199254740995" },
      { ...summary, periodLabel: "Q3 2026", amount: "0", spent: "0" },
    ]);
    expect(lines.map((l) => [l.workgroupName, l.ticker, l.periodLabel])).toEqual([
      ["Dev", "ADA", "September 2026"], ["Design", "GVT", "September 2026"], ["Dev", "ADA", "Q3 2026"],
    ]);
    expect(lines[1]).toMatchObject({ allocated: 9_007_199_254_740_993n, spent: 9_007_199_254_740_995n });
    expect(lines[2]).toMatchObject({ allocated: 0n, spent: 0n });
    expect(budgetLinesFrom([])).toEqual([]);
  });

  it("throws on an amount that is not a whole base-unit quantity rather than rounding it", () => {
    expect(() => budgetLinesFrom([{ ...summary, amount: "3000.5" }])).toThrow();
    expect(() => budgetLinesFrom([{ ...summary, spent: "lots" }])).toThrow();
  });
});
