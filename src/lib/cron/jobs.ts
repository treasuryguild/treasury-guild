// The scheduled jobs, as the /dev tools page and /api/dev/cron know them.
// Client-safe: ids and copy only. The runners live with their concepts
// (`src/lib/reconciliation/sweep.ts`, `src/lib/github/sweep.ts`,
// `src/lib/calls/capture.ts`) and the
// Netlify schedules call them through /api/cron/<id>.

export const CRON_JOB_IDS = ["reconcile", "github-sync", "calls-sync"] as const;
export type CronJobId = (typeof CRON_JOB_IDS)[number];

export interface CronJob {
  id: CronJobId;
  title: string;
  /** Production cadence, for the tool's copy. */
  schedule: string;
  description: string;
}

export const CRON_JOBS: readonly CronJob[] = [
  {
    id: "reconcile",
    title: "Reconcile treasuries",
    schedule: "every 15 minutes",
    description:
      "Applies scheduled workgroup wallet changes whose period has started and moves proposals along (opens voting after the discussion, records results at the deadline, applies passed proposals, announces them on Discord), freezes the tally document of every final proposal that lacks one and publishes frozen documents to the store each community chose (IPFS through the real Pinata account; existing copies are checked weekly), then polls every treasury address through Koios: confirms submitted transactions of every kind (for payouts: writes paid_tx_hash and moves app-board tasks to their Paid column), records incoming funds and tags transfers between the community's own wallets, imports outgoing transactions that carry a Treasury Guild payout or payment record this database did not build (missing tasks are created as paid; what needs a decision waits on the Treasury page), announces outgoing transactions built outside the app to the governance channel of communities with budget consent on, retries GitHub write-backs (payment comment, paid label, move to the repo's Paid status), posts Discord notifications, purges API rate-limit counters older than a day, expired OAuth codes and refresh tokens and AI-client registrations nobody approved, and expired login challenges, puts tasks left queued without a live payout back to payable and lets the app-held co-signer check (and sign) co-signed transactions whose base signers are done. Comments, board moves, publications, notifications and co-signatures are real.",
  },
  {
    id: "github-sync",
    title: "GitHub sync sweep",
    schedule: "hourly",
    description:
      "Re-syncs up to five linked repos that were never synced or not synced in six hours. Reads the real repos and rewrites their tasks locally.",
  },
  {
    id: "calls-sync",
    title: "Call capture",
    schedule: "every 5 minutes",
    description:
      "Takes one snapshot of the voice channel of every Discord call that is running right now (up to twenty), over a single short gateway connection as the real bot. Attendees and their snapshot counts are written locally. Then reads the participant report of up to five Zoom calls that ended at least ten minutes ago, as the real connected Zoom account (parked Zoom events older than 24 hours are then purged), creates the call of each new occurrence of a linked Meet meeting, and reads the conference records of running and just-ended Google Meet calls (up to five each) as the real connected Google account. In production only, it also takes the real bot out of Discord servers no community is connected to, once it has been there an hour.",
  },
];
