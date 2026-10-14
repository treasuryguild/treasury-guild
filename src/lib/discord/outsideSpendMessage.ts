// The Discord message that flags a spend built outside Treasury Guild: an
// outgoing transaction of a treasury that no app build produced and the
// chain import did not claim. Pure and client-safe. It carries the
// treasury, the amounts and the transaction link, never a wallet or a name.
import type { UnitDisplay } from "@/lib/assetRegistry";
import { LOVELACE } from "@/lib/assets";
import { formatLovelace, formatUnits, plural, shortUnit } from "@/lib/format";
import { USERNAME, type DiscordEmbedField, type DiscordWebhookPayload } from "./payoutMessage";

const AMBER = 0xf59e0b;

export interface OutsideSpend {
  txHash: string;
  blockTime: string;
  /** Lovelace paid to other addresses (change excluded). */
  amountLovelace: string;
  /** Tokens paid to other addresses, unit -> quantity. */
  assets: Record<string, string> | null;
  outputs: number;
  /** Another treasury of the community was among the recipients. */
  toSiblingTreasury: boolean;
}

/** "12.5 ₳ · 3,500 GVTT" for what left the treasury. */
export function outsideSpendAmounts(spend: Pick<OutsideSpend, "amountLovelace" | "assets">, display: UnitDisplay): string {
  const parts: string[] = [];
  if (BigInt(spend.amountLovelace) > 0n) parts.push(formatLovelace(spend.amountLovelace));
  for (const [unit, quantity] of Object.entries(spend.assets ?? {})) {
    if (unit === LOVELACE) continue;
    const known = display.get(unit);
    parts.push(known ? formatUnits(quantity, known.decimals, known.ticker) : `${quantity} ${shortUnit(unit)}`);
  }
  return parts.join(" · ") || "no funds (metadata only)";
}

export function buildOutsideSpendEmbed(input: {
  communityName: string;
  treasuryName: string;
  spend: OutsideSpend;
  display: UnitDisplay;
  explorerUrl: string;
}): DiscordWebhookPayload {
  const { spend } = input;
  const fields: DiscordEmbedField[] = [
    { name: "Treasury", value: input.treasuryName, inline: true },
    { name: "Amount", value: outsideSpendAmounts(spend, input.display), inline: true },
    { name: "Recipients", value: plural(spend.outputs, "address", "addresses"), inline: true },
    { name: "Confirmed", value: `<t:${Math.floor(Date.parse(spend.blockTime) / 1000)}:R>`, inline: true },
  ];
  if (spend.toSiblingTreasury) fields.push({ name: "Note", value: "Paid to another of the community's treasuries" });
  return {
    username: USERNAME,
    embeds: [{
      title: "⚠️ Spend built outside Treasury Guild",
      url: input.explorerUrl,
      description:
        `A transaction of **${input.communityName}** moved funds without a Treasury Guild payout or payment record, ` +
        "so it cites no decision and was not checked against the voted budgets.",
      color: AMBER,
      fields,
    }],
  };
}
