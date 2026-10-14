import type { Config } from "@netlify/functions";
import { triggerCron } from "../lib/triggerCron";

const handler = async () =>
  triggerCron("cron-github-sync", "/api/cron/github-sync");

export default handler;

export const config: Config = {
  schedule: "0 * * * *",
};
