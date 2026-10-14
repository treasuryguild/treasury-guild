import type { Config } from "@netlify/functions";
import { triggerCron } from "../lib/triggerCron";

const handler = async () =>
  triggerCron("cron-calls-sync", "/api/cron/calls-sync");

export default handler;

export const config: Config = {
  schedule: "*/5 * * * *",
};
