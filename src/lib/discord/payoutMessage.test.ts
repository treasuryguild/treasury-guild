import { describe, expect, it } from "vitest";
import {
  budgetLine,
  budgetLines,
  buildConnectedEmbed,
  buildPayoutEmbed,
  codeBlock,
  DISCORD_LIMITS,
  embedUsage,
  footerDate,
  footerText,
  MAX_WORKGROUP_LINES,
  payoutTotals,
  spendingLines,
  workgroupSpending,
  type BudgetBalanceLine,
  type PayoutMessageTask,
} from "./payoutMessage";

const ADA = { ticker: "ADA", decimals: 6 };
const GVT = { ticker: "GVT", decimals: 2 };
const HASH = "ab".repeat(32);
const AT = new Date("2026-09-15T10:00:00Z");

function task(overrides: Partial<PayoutMessageTask> = {}): PayoutMessageTask {
  return {
    workgroupName: "Dev",
    amounts: [
      { ...ADA, quantity: 150_000_000n },
      { ...GVT, quantity: 25_000n },
    ],
    recipientWallets: ["addr1alice"],
    ...overrides,
  };
}

const budget = (overrides: Partial<BudgetBalanceLine> = {}): BudgetBalanceLine => ({
  workgroupName: "Dev",
  periodLabel: "September 2026",
  ...ADA,
  allocated: 3_000_000_000n,
  spent: 450_000_000n,
  ...overrides,
});

describe("payoutTotals / workgroupSpending", () => {
  it("multiplies each task's amounts by its recipient count and sums per ticker", () => {
    expect(
      payoutTotals([
        task({ recipientWallets: ["a", "b"] }),
        task({ amounts: [{ ...ADA, quantity: 1_000_000n }] }),
      ]),
    ).toEqual([
      { ...ADA, quantity: 301_000_000n },
      { ...GVT, quantity: 50_000n },
    ]);
  });

  it("groups spending per workgroup, sorted by name", () => {
    const spending = workgroupSpending([
      task({ workgroupName: "Ops", amounts: [{ ...ADA, quantity: 1_000_000n }] }),
      task(),
      task({ recipientWallets: ["a", "b"] }),
    ]);
    expect(spending.map((s) => s.workgroupName)).toEqual(["Dev", "Ops"]);
    expect(spending[0]!.amounts).toEqual([
      { ...ADA, quantity: 450_000_000n },
      { ...GVT, quantity: 75_000n },
    ]);
  });

  it("never does float math on quantities", () => {
    const [line] = spendingLines(
      workgroupSpending([task({ amounts: [{ ...ADA, quantity: 123456789012345678901n }] })]),
    );
    expect(line).toBe("Dev: 123,456,789,012,345.678901 ADA");
  });
});

describe("spendingLines / budgetLines", () => {
  it("caps the workgroup list and truncates long names", () => {
    const spending = workgroupSpending(
      Array.from({ length: MAX_WORKGROUP_LINES + 2 }, (_, i) =>
        task({ workgroupName: `Workgroup ${String(i).padStart(2, "0")} ${"x".repeat(50)}` }),
      ),
    );
    const lines = spendingLines(spending);
    expect(lines).toHaveLength(MAX_WORKGROUP_LINES + 1);
    expect(lines[0]).toMatch(/^Workgroup 00 x+…: 150 ADA \+ 250 GVT$/);
    expect(lines.at(-1)).toBe("…and 2 more workgroups");
    expect(budgetLines(spending, []).at(-1)).toBe("…and 2 more workgroups");
  });

  it("renders balances, overspend and missing budgets per workgroup", () => {
    expect(budgetLine(budget())).toBe("2,550 / 3,000 ADA left");
    expect(budgetLine(budget({ spent: 3_200_000_000n }))).toBe("over by 200 ADA");
    const spending = workgroupSpending([task(), task({ workgroupName: "Design" })]);
    expect(
      budgetLines(spending, [
        budget(),
        budget({ ...GVT, allocated: 50_000n, spent: 0n }),
        budget({ workgroupName: "Design", periodLabel: "Q3 2026", allocated: 1_000_000n, spent: 1_000_000n }),
      ]),
    ).toEqual([
      "Design — Q3 2026",
      "  0 / 1 ADA left",
      "Dev — September 2026",
      "  2,550 / 3,000 ADA left",
      "  500 / 500 GVT left",
    ]);
    expect(budgetLines(spending, [])).toEqual(["Design — no budget", "Dev — no budget"]);
  });
});

describe("footerText", () => {
  it("shows the rate and date, or the date alone", () => {
    expect(footerText({ price: 0.4212, currency: "usd", symbol: "ada" }, AT)).toBe(
      "Exchange rate — 0.4212 USD per ADA — 15 Sep 2026",
    );
    expect(footerText({ price: 1234.5, currency: "eur", symbol: "BTC" }, AT)).toBe(
      "Exchange rate — 1,234.50 EUR per BTC — 15 Sep 2026",
    );
    expect(footerText(null, AT)).toBe("15 Sep 2026");
  });
});

describe("codeBlock", () => {
  it("fences lines as a css block by default", () => {
    expect(codeBlock(["150 ADA", "20 GVT"])).toBe("```css\n150 ADA\n20 GVT\n```");
    expect(codeBlock(["x"], "")).toBe("```\nx\n```");
  });
});

describe("buildPayoutEmbed", () => {
  const base = {
    community: { name: "Guild DAO", url: "https://app.test/c/guild", iconUrl: "https://app.test/logo-white.png" },
    treasuryName: "Main",
    txHash: HASH,
    network: 0 as const,
    at: AT,
  };

  it("builds the full embed: author, links, code-block fields, counters, footer", () => {
    const payload = buildPayoutEmbed({
      ...base,
      links: { transaction: "https://app.test/c/guild/tx/1", dashboard: "https://app.test/c/guild/dashboard" },
      tasks: [task(), task({ workgroupName: "Ops", amounts: [{ ...ADA, quantity: 1_000_000n }], recipientWallets: ["addr1bob"] })],
      budgets: [budget()],
      balance: { url: "https://preprod.cexplorer.io/address/addr_test1x", amounts: [{ ...ADA, quantity: 9_000_000_000n }] },
      rate: { price: 0.42, currency: "usd", symbol: "ADA" },
    });
    expect(payload.username).toBe("Guild Vault");
    const embed = payload.embeds[0]!;
    expect(embed.author).toEqual({
      name: "Guild DAO",
      url: "https://app.test/c/guild",
      icon_url: "https://app.test/logo-white.png",
    });
    expect(embed.title).toBe("💸 Payout from Main");
    expect(embed.url).toBe(`https://preprod.cexplorer.io/tx/${HASH}`);
    expect(embed.description).toBe(
      `[Transaction](https://app.test/c/guild/tx/1)  ·  [Dashboard](https://app.test/c/guild/dashboard)  ·  [Explorer](https://preprod.cexplorer.io/tx/${HASH})`,
    );
    expect(embed.fields).toEqual([
      { name: "Total paid", value: "```css\n151 ADA\n250 GVT\n```" },
      { name: "Spending by workgroup", value: "```css\nDev: 150 ADA + 250 GVT\nOps: 1 ADA\n```" },
      { name: "Budget balance", value: "```css\nDev — September 2026\n  2,550 / 3,000 ADA left\nOps — no budget\n```" },
      {
        name: "Treasury balance",
        value: "[Main on explorer](https://preprod.cexplorer.io/address/addr_test1x)\n```css\n9,000 ADA\n```",
      },
      { name: "Tasks", value: "2", inline: true },
      { name: "Recipients", value: "2", inline: true },
      {
        name: "Transaction",
        value: `[\`${HASH.slice(0, 16)}…\`](https://preprod.cexplorer.io/tx/${HASH})`,
        inline: true,
      },
    ]);
    expect(embed.footer).toEqual({ text: "Exchange rate — 0.42 USD per ADA — 15 Sep 2026" });
    expect(embed.timestamp).toBe("2026-09-15T10:00:00.000Z");
  });

  it("omits optional parts: links, balance, rate, community url/icon", () => {
    const embed = buildPayoutEmbed({
      ...base,
      community: { name: "Guild DAO" },
      tasks: [task()],
      budgets: [],
      balance: null,
      rate: null,
    }).embeds[0]!;
    expect(embed.author).toEqual({ name: "Guild DAO" });
    expect(embed.description).toBe(`[Explorer](https://preprod.cexplorer.io/tx/${HASH})`);
    expect(embed.fields?.map((f) => f.name)).toEqual([
      "Total paid",
      "Spending by workgroup",
      "Budget balance",
      "Tasks",
      "Recipients",
      "Transaction",
    ]);
    expect(embed.footer).toEqual({ text: "15 Sep 2026" });
  });

  it("counts distinct wallets across tasks and uses the mainnet explorer for network 1", () => {
    const embed = buildPayoutEmbed({
      ...base,
      network: 1,
      tasks: [task({ recipientWallets: ["a", "b"] }), task({ recipientWallets: ["b"] })],
      budgets: [],
    }).embeds[0]!;
    expect(embed.url).toBe(`https://cexplorer.io/tx/${HASH}`);
    expect(embed.fields?.find((f) => f.name === "Recipients")?.value).toBe("2");
  });
});

describe("embedUsage", () => {
  it("counts description and total characters and names exceeded limits", () => {
    const ok = buildPayoutEmbed({
      community: { name: "Guild" },
      treasuryName: "Main",
      txHash: HASH,
      network: 0,
      tasks: [task()],
      budgets: [],
    });
    const usage = embedUsage(ok);
    expect(usage.over).toEqual([]);
    expect(usage.description).toBe(ok.embeds[0]!.description!.length);
    expect(usage.total).toBeGreaterThan(usage.description);

    const huge = {
      username: "x",
      embeds: [
        {
          title: "t",
          // 5000 + 1025 + 1 > 6000, so the overall cap trips as well
          description: "d".repeat(5000),
          fields: [{ name: "Total", value: "v".repeat(DISCORD_LIMITS.fieldValue + 1) }],
          footer: { text: "f".repeat(DISCORD_LIMITS.footer + 1) },
        },
      ],
    };
    expect(embedUsage(huge).over).toEqual(["description", 'field "Total" value', "footer", "embed total"]);
  });
});

describe("buildConnectedEmbed", () => {
  it("names the treasury", () => {
    const payload = buildConnectedEmbed("Main treasury");
    expect(payload.embeds[0]!.description).toContain("**Main treasury**");
  });
});

describe("footerDate", () => {
  it("renders day, short month and year without padding", () => {
    expect(footerDate(new Date("2026-09-15T10:00:00Z"))).toBe("15 Sep 2026");
    expect(footerDate(new Date("2026-01-05T00:00:00Z"))).toBe("5 Jan 2026");
    expect(footerDate(new Date("2024-02-29T12:00:00Z"))).toBe("29 Feb 2024");
  });

  it("uses fixed three-letter month names for every month", () => {
    const names = Array.from({ length: 12 }, (_, m) => footerDate(new Date(Date.UTC(2026, m, 1))).split(" ")[1]);
    expect(names).toEqual(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
  });

  it("reads the date in UTC, whatever offset the instant was written with", () => {
    expect(footerDate(new Date("2026-09-15T23:30:00-05:00"))).toBe("16 Sep 2026");
    expect(footerDate(new Date("2026-09-15T00:30:00+02:00"))).toBe("14 Sep 2026");
    expect(footerDate(new Date("2026-12-31T23:59:59Z"))).toBe("31 Dec 2026");
    expect(footerDate(new Date("2027-01-01T00:00:00Z"))).toBe("1 Jan 2027");
  });

  it("is the date the footer ends with, with or without a rate", () => {
    expect(footerText(null, AT)).toBe(footerDate(AT));
    expect(footerText({ price: 0.42, currency: "usd", symbol: "ada" }, AT).endsWith(` — ${footerDate(AT)}`)).toBe(true);
  });
});
