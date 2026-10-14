// Registry of the internal developer tools shown on /dev. Adding a tool:
// write its component under src/components/dev/, add an entry here, and (if
// it needs the server) an /api/dev/<tool>/route.ts on `devRoute`.
import type { ComponentType } from "react";
import { AnchorTestTool } from "./AnchorTestTool";
import { CronTriggerTool } from "./CronTriggerTool";
import { DiscordMessageTool } from "./DiscordMessageTool";

export interface DevTool {
  /** Section anchor (#id) on the page. */
  id: string;
  title: string;
  description: string;
  Component: ComponentType;
}

export const DEV_TOOLS: readonly DevTool[] = [
  {
    id: "cron",
    title: "Scheduled jobs",
    description:
      "Run the reconcile or GitHub-sync sweep now. The Netlify schedules never reach a local stack, so this is how a payout submitted from local data gets confirmed.",
    Component: CronTriggerTool,
  },
  {
    id: "discord-message",
    title: "Discord message tester",
    description:
      "Preview the payout notification scenarios and post them to a webhook of your choice, so a change to the message format can be checked in a real channel.",
    Component: DiscordMessageTool,
  },
  {
    id: "anchor-test",
    title: "Anchor test transaction",
    description:
      "Build a metadata-only transaction (label 190002, no outputs) from a treasury and sign it on the normal transaction page: the preprod check that the ledger and the poller accept the shape proposal anchors use.",
    Component: AnchorTestTool,
  },
];
