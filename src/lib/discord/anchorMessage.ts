// Discord messages for on-chain anchor reminders: stale due steps, and a
// heads-up before the closed step's copy-grace window ends. Pure and
// client-safe. Carries proposal numbers and step names only — never a
// wallet or a member's name.
import type { AnchorStep } from "@/lib/constants";
import { plural, truncate } from "@/lib/format";
import { USERNAME, type DiscordEmbedField, type DiscordWebhookPayload } from "./payoutMessage";

const INDIGO = 0x6366f1;
const AMBER = 0xf59e0b;

const STEP_LABEL: Record<AnchorStep, string> = {
  proposed: "proposed",
  opened: "voting opened",
  closed: "closed",
};

export interface StaleAnchorLine {
  number: number;
  title: string;
  step: AnchorStep;
}

/** One digest for every newly stale due step in the community. */
export function buildStaleAnchorsEmbed(input: {
  communityName: string;
  lines: readonly StaleAnchorLine[];
  proposalsUrl: string;
}): DiscordWebhookPayload {
  const { lines } = input;
  const listed = lines.slice(0, 15).map((line) =>
    `• **#${line.number}** ${truncate(line.title, 60)} — ${STEP_LABEL[line.step]}`);
  const more = lines.length > 15 ? `\n…and ${lines.length - 15} more` : "";
  const fields: DiscordEmbedField[] = [
    {
      name: plural(lines.length, "Step due", "Steps due"),
      value: `${listed.join("\n")}${more}`,
    },
  ];
  return {
    username: USERNAME,
    embeds: [{
      title: "On-chain anchors waiting",
      url: input.proposalsUrl,
      description:
        `**${input.communityName}** has proposal fingerprints due on-chain for three days or more. ` +
        "The next payout or payment carries them; or build an anchor transaction from the Proposals or Treasury page.",
      color: INDIGO,
      fields,
    }],
  };
}

/** Heads-up while the closed step still waits for a published tally copy. */
export function buildCopyGraceEmbed(input: {
  communityName: string;
  number: number;
  title: string;
  proposalUrl: string;
  graceEndsAt: string;
}): DiscordWebhookPayload {
  const endsUnix = Math.floor(Date.parse(input.graceEndsAt) / 1000);
  return {
    username: USERNAME,
    embeds: [{
      title: `Tally copy needed · Proposal #${input.number}`,
      url: input.proposalUrl,
      description:
        `**${input.communityName}** frozen the voting record for **${truncate(input.title, 80)}**, ` +
        "but its outside copy is not published yet. Publish it before the grace window ends, " +
        "or the closed on-chain anchor will go without the locator.",
      color: AMBER,
      fields: [
        { name: "Grace ends", value: `<t:${endsUnix}:R>`, inline: true },
      ],
    }],
  };
}
