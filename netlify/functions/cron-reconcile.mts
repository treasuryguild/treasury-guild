import type { Config } from "@netlify/functions";
import { triggerCron } from "../lib/triggerCron";

const handler = async () =>
  triggerCron("cron-reconcile", "/api/cron/reconcile");

export default handler;

export const config: Config = {
  schedule: "*/15 * * * *",
};
