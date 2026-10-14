import { describe, expect, it } from "vitest";
import type { UnitDisplay } from "@/lib/assetRegistry";
import { buildOutsideSpendEmbed, outsideSpendAmounts, type OutsideSpend } from "./outsideSpendMessage";

const GVTT = `${"a".repeat(56)}47565454`;
const display: UnitDisplay = new Map([[GVTT, { ticker: "GVTT", decimals: 2 }]]);
const spend: OutsideSpend = {
  txHash: "f".repeat(64), blockTime: "2026-09-30T10:00:00Z", amountLovelace: "12500000",
  assets: { [GVTT]: "350000", [`${"b".repeat(56)}00`]: "7" }, outputs: 3, toSiblingTreasury: false,
};

describe("outsideSpendAmounts", () => {
  it("lists ADA first, then known tokens by ticker and unknown ones by unit", () => {
    expect(outsideSpendAmounts(spend, display)).toBe(`12.5 ₳ · 3,500 GVTT · 7 ${"b".repeat(12)}…`);
  });

  it("says so when nothing left the treasury", () => {
    expect(outsideSpendAmounts({ amountLovelace: "0", assets: null }, display)).toBe("no funds (metadata only)");
  });
});

describe("buildOutsideSpendEmbed", () => {
  it("names the treasury, the amounts and the link, never a wallet or a name", () => {
    const payload = buildOutsideSpendEmbed({
      communityName: "Signius", treasuryName: "Main", spend, display, explorerUrl: "https://preprod.cexplorer.io/tx/f",
    });
    const embed = payload.embeds[0]!;
    expect(embed.title).toBe("⚠️ Spend built outside Treasury Guild");
    expect(embed.url).toBe("https://preprod.cexplorer.io/tx/f");
    expect(embed.description).toContain("**Signius**");
    expect(embed.fields).toEqual([
      { name: "Treasury", value: "Main", inline: true },
      { name: "Amount", value: expect.stringContaining("12.5 ₳"), inline: true },
      { name: "Recipients", value: "3 addresses", inline: true },
      { name: "Confirmed", value: "<t:1790762400:R>", inline: true },
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/addr1|addr_test1/);
  });

  it("notes a payment to a sibling treasury", () => {
    const payload = buildOutsideSpendEmbed({
      communityName: "Signius", treasuryName: "Main", spend: { ...spend, toSiblingTreasury: true }, display, explorerUrl: "u",
    });
    expect(payload.embeds[0]!.fields?.at(-1)).toEqual({ name: "Note", value: "Paid to another of the community's treasuries" });
  });
});
