"use client";

// Dev tool: run a scheduled job now and show what it returned. The Netlify
// schedules never reach a local stack, so a payout submitted from local data
// only gets its paid_tx_hash when the reconcile sweep is run from here.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { DevCronRunResponse } from "@/lib/api/types";
import { CRON_JOBS, type CronJobId } from "@/lib/cron/jobs";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, InsetRow, JsonDetails, NoticeText } from "@/components/ui";

export function CronTriggerTool() {
  const [running, setRunning] = useState<CronJobId | null>(null);
  const [last, setLast] = useState<DevCronRunResponse | null>(null);
  const action = useAsyncAction();

  async function run(job: CronJobId) {
    setRunning(job);
    setLast(null);
    const result = await action.run(() =>
      apiFetch<DevCronRunResponse>("/api/dev/cron", { body: { job } }),
    );
    setRunning(null);
    if (result) setLast(result);
  }

  const lastJob = last ? CRON_JOBS.find((j) => j.id === last.job) : null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {CRON_JOBS.map((job) => (
          <InsetRow key={job.id}>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-zinc-200">
                {job.title}{" "}
                <span className="text-xs text-zinc-500">({job.schedule} in production)</span>
              </p>
              <p className="text-xs text-zinc-400">{job.description}</p>
            </div>
            <Button
              variant="secondary"
              onClick={() => void run(job.id)}
              loading={running === job.id}
              disabled={action.busy}
            >
              {running === job.id ? "Running…" : "Run now"}
            </Button>
          </InsetRow>
        ))}
      </div>
      <ErrorText error={action.error} />
      {last && lastJob && (
        <div>
          <NoticeText>
            {lastJob.title} finished in {(last.ms / 1000).toFixed(1)} s.
          </NoticeText>
          <JsonDetails label="Result" value={last.result} open />
        </div>
      )}
    </div>
  );
}
