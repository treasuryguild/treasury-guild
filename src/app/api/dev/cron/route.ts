// Developer tool: run one scheduled job now. The Netlify schedules never
// reach a local stack, so this is how a locally submitted payout gets
// confirmed. DEV_WALLETS only (devRoute).
import { devRoute, parseJson } from "@/lib/api/route";
import { devCronRunSchema } from "@/lib/api/schemas";
import type { DevCronRunResponse } from "@/lib/api/types";
import { runCallsSync } from "@/lib/calls/capture";
import type { CronJobId } from "@/lib/cron/jobs";
import { runGithubSyncSweep } from "@/lib/github/sweep";
import { runReconcileSweep } from "@/lib/reconciliation/sweep";

const RUNNERS: Record<CronJobId, () => Promise<DevCronRunResponse["result"]>> = {
  reconcile: runReconcileSweep,
  "github-sync": runGithubSyncSweep,
  "calls-sync": runCallsSync,
};

export const POST = devRoute(async (req) => {
  const { job } = await parseJson(req, devCronRunSchema);
  const started = Date.now();
  const result = await RUNNERS[job]();
  return { job, ms: Date.now() - started, result } satisfies DevCronRunResponse;
});
