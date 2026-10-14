import { describe, expect, it } from "vitest";
import { shortUnit } from "@/lib/format";
import {
  buildScenario,
  DISCORD_SCENARIO_IDS,
  DISCORD_SCENARIOS,
  UNKNOWN_UNIT,
} from "./fixtures";
import { embedUsage, MAX_WORKGROUP_LINES } from "./payoutMessage";

const field = (id: (typeof DISCORD_SCENARIO_IDS)[number], name: string) =>
  buildScenario(id).embeds[0]!.fields?.find((f) => f.name === name)?.value ?? "";

describe("Discord scenarios", () => {
  it("registers every id exactly once, in order", () => {
    expect(DISCORD_SCENARIOS.map((s) => s.id)).toEqual([...DISCORD_SCENARIO_IDS]);
  });

  it("builds every scenario within Discord's limits, deterministically", () => {
    for (const id of DISCORD_SCENARIO_IDS) {
      const first = buildScenario(id);
      expect(first.embeds, id).toHaveLength(1);
      expect(embedUsage(first).over, id).toEqual([]);
      expect(JSON.stringify(buildScenario(id)), id).toBe(JSON.stringify(first));
    }
  });

  it("kitchen sink exercises every rendering path", () => {
    const embed = buildScenario("kitchen-sink").embeds[0]!;
    expect(embed.author).toMatchObject({ name: "Guild DAO", icon_url: expect.stringContaining("/logo-white.png") });
    expect(embed.description).toMatch(/\[Transaction\]\(.+\)  ·  \[Dashboard\]\(.+\)  ·  \[Explorer\]\(https:\/\/preprod\.cexplorer\.io\/tx\//);

    const spending = field("kitchen-sink", "Spending by workgroup");
    expect(spending).toContain("Dev: 750 ADA + 501 GVT");                  // 150 + 300×2 ADA, 250.50×2 GVT
    expect(spending).toMatch(/Design & Community Outreach Working Gro…: 7,000,000 HOSKY/); // truncated name, ×7 recipients
    expect(spending).toContain(`Ops: 0.000001 ADA + 500 ${shortUnit(UNKNOWN_UNIT)}`); // dust + hex fallback
    expect(spending).toContain("Research: 123,456,789,012,345.678901 ADA"); // exact big number
    expect(spending).toContain("Events: 37.02 GVT");                        // token only, ×3

    const budgets = field("kitchen-sink", "Budget balance");
    expect(budgets).toContain("Dev — September 2026\n  2,250 / 3,000 ADA left\n  over by 125 GVT");
    expect(budgets).toContain("Design & Community Outreach Working Gro… — Q3 2026\n  1,750,000 / 5,000,000 HOSKY left");
    expect(budgets).toContain("Research — September 2026\n  0 / 200,000,000,000,000 ADA left");
    expect(budgets).toContain("Events — no budget");
    expect(budgets).toContain("Ops — no budget");

    const balance = field("kitchen-sink", "Treasury balance");
    expect(balance).toMatch(/^\[Main treasury on explorer\]\(https:\/\/preprod\.cexplorer\.io\/address\//);
    expect(balance).toContain("987,654.321 ADA\n123,456.78 GVT\n999,999,999,999 HOSKY");
    expect(embed.footer?.text).toBe("Exchange rate — 0.4212 USD per ADA — 15 Sep 2026");
    expect(field("kitchen-sink", "Recipients")).toBe("15");
    expect(field("kitchen-sink", "Tasks")).toBe("6");
  });

  it("covers the optional parts, the workgroup cap and mainnet links", () => {
    const bare = buildScenario("no-extras").embeds[0]!;
    expect(bare.author).toEqual({ name: "Guild DAO" });
    expect(bare.description).toMatch(/^\[Explorer\]/);
    expect(bare.fields?.map((f) => f.name)).not.toContain("Treasury balance");
    expect(bare.footer?.text).toBe("15 Sep 2026");

    const many = field("many-workgroups", "Spending by workgroup").split("\n");
    expect(many).toHaveLength(MAX_WORKGROUP_LINES + 1 + 2); // lines + "+N more" + fences
    expect(many.at(-2)).toBe("…and 4 more workgroups");

    const mainnet = buildScenario("mainnet").embeds[0]!;
    expect(mainnet.url).toMatch(/^https:\/\/cexplorer\.io\/tx\//);
    expect(field("mainnet", "Treasury balance")).toContain("(https://pool.pm/");
    expect(buildScenario("connected").embeds[0]!.title).toContain("connected");
  });
});
