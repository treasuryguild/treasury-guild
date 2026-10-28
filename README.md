# Treasury Guild

Cardano treasury manager for communities: multisig treasuries, GitHub-synced
task boards, batch payouts anchored on-chain, and refund reconciliation.

- **Multisig treasuries** — native-script wallets (new ones use CIP-1854 key
  ordering; an existing wallet can be imported from its native-script CBOR,
  keeping its key order), threshold signing with CIP-30 wallets, partial signatures collected in the
  app and assembled server-side. Four fixed script **templates**: plain,
  clawback (recovery signers from a lock date), lock-until, and co-signer
  (a member or an app-held key that signs only what passes a check, with a
  bypass path for every base signer); each transaction is built for one
  spending path.
- **Task boards** — native kanban boards per workgroup, or GitHub repos /
  Projects v2 synced via a GitHub App. Issues carrying the payable label
  (`audited` by default) **and** the configured Projects v2 status column
  (`In review` by default) are imported and become payable.
- **Payday** — select payable tasks, build one batch transaction with one
  output per contributor wallet, plus JSON metadata (label `190001`) naming,
  per output, the task numbers, workgroup, budget period and amounts. A
  CIP-20 (674) message rides along.
- **Payments** — the same flow for money that is not a task bounty:
  contractors, other communities, members outside a workgroup budget, or
  transfers between the community's own treasuries. Same label, a distinct
  record marked `t: "payment"`.
- **Reconciliation** — incoming refunds to the treasury are detected via Koios
  polling and matched back to payouts.
- **Chain import** — an outgoing transaction that carries a Treasury Guild
  label-`190001` record this database did not build (another deployment, a
  lost local record) is rebuilt from the chain as the payout or payment the
  app would have written; what needs a decision waits on the Treasury page.
- **Calls** — attendance rewards for Discord, Zoom and Google Meet calls:
  attendees are captured (voice-channel snapshots, Zoom webhooks + participant
  report, Meet conference records, or a wallet check-in code) and a finalized
  call becomes ordinary native tasks paid on Payday.
- **Budgets and Dashboard** — monthly or quarterly allocations per token, one
  per workgroup (task payouts) and one per treasury (manual payments), with
  full change history and spend-vs-plan charts.
- **Proposals & voting** — decisions, budget changes (budget consent), new
  workgroups and tasks put to a vote; every ballot is a CIP-30 signature, and
  a closed vote downloads as a signed tally anyone can re-verify. Final
  tallies are frozen (optionally published to IPFS or a GitHub archive), each proposal's
  fingerprints are **anchored** on-chain (label `190002`), payouts and
  payments cite the decisions behind them and are checked against the voted
  budgets.
- **Funding sources** — outside funders and their commitments (one-off,
  recurring or a schedule), compared with the inflows tagged to them.
- **Previous-wallet history** — payments made from the wallet a community
  used before Treasury Guild, imported from a CSV and counted in budgets.
- **Minting** — tokens and NFTs minted under the treasury's own multisig
  script, optionally time-locked, with images on IPFS.
- **AI assistants** — an MCP server (`/api/mcp`) and REST API (`/api/v1`)
  behind the app's own OAuth server: reads, plus previewed writes the user
  confirms (proposals and withdrawals, tasks, calls and their attendance,
  payout transactions to sign); no assistant ever signs, submits or votes.

Stack: Next.js (App Router) · MeshJS · Koios · Supabase (RLS) · Netlify.

## Documentation

- [Product overview](docs/OVERVIEW.md) — concepts and the contributor payment flow.
- [Contributing](CONTRIBUTING.md) — branch/PR workflow, setup and pre-PR checks.
- User guides at `/docs` in the running app; source in [src/content/docs](src/content/docs).
- [Development and database commands](scripts/README.md).
- [Signius test seeds](supabase/seeds/README.md).
- [Agent API: MCP and REST](src/app/api/mcp/README.md).
- [Development conventions](CLAUDE.md) and [repository instructions](AGENTS.md).
- Design records: [on-chain anchoring, treasury templates and the co-signer](docs/onchain-anchoring-estimate.md)
  and the [fix plan from the 2026-10-01 test sweep](docs/test-findings-fix-plan.md).

When a user flow changes, update its guide in `src/content/docs/` in the
same change. Register new guides and page help links in `src/lib/docs.ts`;
keep heading anchors in sync with cross-links. Run
`npm test -- src/lib/docs.test.ts` to check the registry, route coverage and
cross-document anchors. Setup changes also belong here and in
`scripts/README.md`; environment changes belong in `.env.example`.

## Task lifecycle

On native boards, admins and workgroup leads can open a task and choose
**Archive task** to remove it from the board and Payday. **Archived tasks**
contains the retained tasks; **Manage** offers restoration to the original
column and payment status. Pending payouts must be resolved before archiving.
Archived tasks with no payment records and no paid/reconciled status may be
permanently deleted after typing the exact title. Payment history is retained,
and lifecycle events record who archived, restored, or deleted each task.
GitHub tasks remain managed on GitHub: the sync deletes an unpaid task whose
issue left the import filter (`0041_github_task_delete.sql` lets the service
role delete unsettled GitHub tasks that have no payout rows).

The database (`supabase/migrations/0021_task_lifecycle.sql`) enforces
permissions, archive immutability, and payout/deletion guards, including
payout builds using stale task data. `supabase/tests/task_lifecycle.sql`
verifies the migrations and the task lifecycle protections; run it in a
throwaway Postgres container (see [SQL fixtures](#sql-fixtures)).

## Workgroup lifecycle

Workgroups support admin-only **Archive / delete** inside **Edit details**, opened
from the overview or board header. Archive pauses editing and GitHub imports, preserves historical reports,
and requires payable/queued tasks and pending payouts to be resolved first.
Use **Show archived** on the overview to find and restore a workgroup. Permanent
deletion requires typing the exact name and is limited to workgroups with no
remaining tasks. Remove eligible unpaid tasks through their task lifecycle first,
including archived tasks; payment records remain protected. Deletion automatically
clears budget configuration, empty board columns, and local GitHub links. Archive,
restore, and deletion record the actor and timestamp. Deletion also retains a
complete budget snapshot in the community audit record.

`supabase/migrations/0020_workgroup_lifecycle.sql` adds the archive metadata,
retained lifecycle events (`workgroup_events`), activity tracking
(`has_activity`, seeded from existing task and budget records; activity
deleted before that migration cannot be reconstructed) and the database
guards for concurrent writes. GitHub repositories and issues are never
deleted. `supabase/tests/workgroup_lifecycle.sql` verifies the lifecycle rules
and permissions (see [SQL fixtures](#sql-fixtures)).

## Several treasuries and funding flow

A community with more than one treasury (typically a main wallet funding
per-workgroup wallets) gets a **Funding flow** diagram on the Dashboard:
income sources → wallets → workgroups per token and period. Transfers between
the community's own wallets are recognised on-chain by the poller
(`tag_internal_transfers`), logged on Incoming without review and excluded
from income and spending. A workgroup's **Payment wallet** is now a dated
timeline (`workgroup_treasury_assignments`): a change takes effect at a
budget period boundary (this period only while nothing has been paid in it),
is recorded with actor, time and reason, and build-payout resolves each task's
wallet for the task's own period, so spending history is never split.

`supabase/migrations/0034_internal_transfers.sql` adds the tagging;
`0035_workgroup_treasury_assignments.sql` adds the timeline and revokes the
browser's write access to `workgroups.treasury_id` (writes go through
`POST /api/workgroups/routing`, which calls the `set_workgroup_treasury` RPC;
the reconcile cron applies scheduled changes with
`apply_workgroup_treasury_assignments`). `supabase/tests/internal_transfers.sql`
and `supabase/tests/workgroup_treasury_routing.sql` verify both.

### Resetting mistaken budgets

Admins can use **Reset budgets** beside a workgroup in the budget worksheet.
Save or discard that workgroup's staged edits first. Reset requires the exact
workgroup name and a reason, and clears all periods, scheduled setups, plans,
legacy budgets, and displayed change history. The workgroup returns to **No setup**.
The previous configuration and full change history are retained in
`workgroup_events.budget_snapshot`, with the actor, time, and reason, even after
the workgroup is deleted. Existing audit rows cannot be updated or deleted by
application roles.

Reset is unavailable for archived workgroups, any payout history (including
rejected transactions), paid/reconciled tasks, or payable/queued tasks, including
archived ones. Other unpaid tasks are preserved. Correct budget amounts through
the normal editor when reset is blocked by payment history. Budget revision checks
and workgroup row locks protect against stale editors and concurrent mutations.
While budget consent is on (see [Proposals and voting](#proposals-and-voting)),
reset is refused like any direct budget save.

The reset lives in `supabase/migrations/0022_budget_reset.sql`
(`reset_workgroup_budgets`, service-role only, called by
`POST /api/budgets/reset`). `supabase/tests/budget_reset.sql` checks
reset/deletion, audit retention, payment blockers, permissions, legacy
migration, and revision conflicts (see [SQL fixtures](#sql-fixtures)).

## Setup

Use **Node.js 22 or newer** (Netlify uses 22), npm, Docker
Desktop and the Supabase CLI on your PATH. There are no database helper
scripts: the `npm run db:*` / `seed:*` commands are thin aliases over the
Supabase CLI and `psql`. Seeds and SQL fixtures need `psql` (PostgreSQL
17 client tools to match the local database).

### 1. Supabase

Day-to-day development runs against a **local Supabase stack** in Docker
(`npm run db:start`), built from `supabase/migrations/` and seeded with a data
snapshot of the remote project when available. Local database commands never
write to the remote; `supabase db push` deploys schema changes, while running
the app or seeds against the remote can also write remote data. See
[`scripts/README.md`](scripts/README.md) for the whole loop.

For the remote project: create it, then apply the migrations in
`supabase/migrations/` in order with the Supabase CLI (`supabase login`,
`supabase link --project-ref <ref>`, `supabase db push`), or paste them into
the SQL editor. All database work uses the bare CLI — there is no wrapper
script to create on a fresh clone.

Collect (these go into `.env.remote`; `.env` holds the local stack's values):
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET` — the **legacy JWT secret** (Project Settings → API).
  On new projects using signing keys, enable the legacy secret; the app mints
  wallet-session JWTs with it so RLS policies can read the `wallet` claim.
- `SUPABASE_DB_URL` — the database connection string (Project Settings →
  Database), only if you want a direct `pg_dump`/`psql` connection by hand;
  `npm run db:snapshot` dumps the **linked** project and needs no connection
  string.

### 2. Koios

No key needed to start, but get a free API key at https://koios.rest — the
anonymous tier is tightly rate-limited. One key (`KOIOS_API_KEY`) serves both
networks.

Every community chooses its Cardano network (mainnet or preprod) when it is
created and keeps it: its treasuries, payouts and mints live there, and the
app queries the matching Koios host per treasury. A single deployment can
therefore host real communities next to preprod test communities.
`NEXT_PUBLIC_NETWORK` (0 = preprod, 1 = mainnet) is only the option
preselected on the new-community form. `KOIOS_BASE_URL_MAINNET` /
`KOIOS_BASE_URL_PREPROD` optionally point one network at a mirror.

### 3. GitHub App (optional, for GitHub boards)

Create a GitHub App (Settings → Developer settings → GitHub Apps):
- **Webhook URL**: `https://app.treasuryguild.com/api/github/webhook`, with a secret →
  `GITHUB_WEBHOOK_SECRET`
- **Setup URL**: `https://app.treasuryguild.com/api/github/setup` (check "Redirect on
  update")
- **Repository permissions**: Issues (read & write), Metadata (read),
  Contents (read & write — publishes frozen tally records to a community's
  chosen archive repository when Governance settings use GitHub; existing
  installations must approve the upgraded permission before publish works)
- **Organization permissions**: Projects (read & write — write moves paid
  issues to the repo's Paid status; existing installations must approve the
  upgraded permission before the move works)
- **Events**: Issues, Projects v2 item, Installation
- **Visibility**: make the app public — "Where can this GitHub App be
  installed?" must be **Any account** (for an existing app: Advanced →
  Make public). A private app can only be installed on the account that
  owns it, so GitHub's install page would never offer a community's
  organisation. Installing on an organisation must be done by an
  organisation owner, because the app requests an Organization permission
  (Projects) — repository admins cannot complete that install.
- Generate a private key → `GITHUB_APP_PRIVATE_KEY` (replace newlines with
  `\n`), and set `GITHUB_APP_ID` + `GITHUB_APP_SLUG` (the install link is
  `https://github.com/apps/<slug>/installations/new`).
- **Identifying and authorizing users**: callback URL
  `https://app.treasuryguild.com/api/github/oauth-callback`; the client id and secret
  from the same page → `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`. Used only
  for the one-off GitHub-account ↔ wallet link on the Settings page (no
  scopes, public profile only).

For local webhook testing, proxy with [smee.io](https://smee.io).

### Pinata (optional, for minting)

Token images minted from the Mint page are pinned to IPFS through Pinata
presigned upload URLs (`/api/ipfs/sign-upload`; the browser uploads straight
to Pinata). Create an API key with the **Files: write** scope →
`PINATA_JWT` (server-only). `PINATA_GATEWAY` optionally names your dedicated
gateway host; empty falls back to `gateway.pinata.cloud`. The same account
can publish frozen tally records when a community chooses IPFS under
Governance settings (`src/lib/storage/`). Communities may instead publish
to a dedicated GitHub archive repository on their App installation.

### Discord notifications (optional)

No environment variable for payouts: on Integrations, a community admin
picks a text/announcement channel on the connected Discord server (bot
posts) or pastes an incoming webhook URL per treasury (stored in
`treasury_discord_destinations`, service-role only, migration 0072). The
reconcile cron posts a summary of each confirmed payout to it. Proposal
announcements use the community's Discord bot connection (Call capture)
plus a channel chosen under Integrations (`governance_discord_channels`,
migration 0071): up for discussion (with an auto discussion thread/forum
post when the proposal has a discussion period), voting open, a day left,
the result. While budget consent is on it also gets one post per outgoing
transaction built outside Treasury Guild (migration 0059; treasury,
amounts and tx link, never a recipient).

### Call attendance: Discord, Zoom, Google (optional)

Each platform is independent; leave its variables empty to go without it.
`.env.example` carries the same notes next to each variable.

- **Discord** — one application serves both uses. OAuth2 client →
  `DISCORD_CLIENT_ID` + `DISCORD_CLIENT_SECRET`, with the redirects
  `https://app.treasuryguild.com/api/discord/oauth-callback` (members link their account
  on the profile page, scope `identify`) and
  `https://app.treasuryguild.com/api/discord/guild-callback` (an admin adds the bot to
  the community's server for call capture and, when a channel is chosen under
  Governance, proposal announcements and discussion threads). Bot token →
  `DISCORD_BOT_TOKEN`; voice capture needs no privileged intents.
- **Zoom** — a General (OAuth, user-managed) app on marketplace.zoom.us →
  `ZOOM_CLIENT_ID` + `ZOOM_CLIENT_SECRET`, redirect
  `https://app.treasuryguild.com/api/zoom/oauth-callback`, scopes to read the user and
  past meeting participants. Event subscription endpoint
  `https://app.treasuryguild.com/api/zoom/webhook` with participant joined, participant
  left and meeting ended; its Secret Token → `ZOOM_WEBHOOK_SECRET_TOKEN`.
- **Google** — one OAuth web client → `GOOGLE_CLIENT_ID` +
  `GOOGLE_CLIENT_SECRET`. Redirect
  `https://app.treasuryguild.com/api/google/oauth-callback` for the personal link (scope
  `openid` only). For Meet capture also register
  `https://app.treasuryguild.com/api/google/host-callback`, enable the Google Meet REST
  API and add the scope `meetings.space.readonly` (sensitive: hosts see an
  "unverified app" notice until Google verifies the app).

Personal links store no provider token; the host grants (Zoom, Google) keep
theirs in `call_integration_secrets`. What is stored about a person is stated
in the privacy policy (`src/content/docs/privacy.mdx`).

### 4. Run

```powershell
Copy-Item .env.example .env  # first setup only; configure CRON_SECRET and the integrations you use
npm ci
npm run db:start             # local Supabase stack (Docker Desktop running)
# copy the Supabase values from `supabase status -o env` into .env (mapping in scripts/README.md)
npm run dev                  # http://localhost:3000 against the local stack
```

Without a snapshot the local database starts empty: sign in, create a
community and set up its treasury and workgroups. To use the existing
Signius test scenarios instead, stop the dev server and run:

```powershell
npm run db:snapshot          # copy the remote data locally (dumps the linked project)
npm run db:reset             # replaces local data: migrate from scratch + load the snapshot
npm run seed:sandbox         # needs Signius members and its GVTT mint in the snapshot
npm run dev                  # http://localhost:3000 against the local stack
```

`npm run dev` uses Next.js environment loading; it targets whatever `.env`
points at (the local stack once you have copied the `supabase status -o env`
values in), unless process variables or a higher-priority env file such as
`.env.local` override it. To run against the remote project, load the values
from `.env.remote` into the process environment first (snippet in
`scripts/README.md`). Both can submit real
transactions on each community's network.

`npm test` runs Vitest tests for library logic, API routes, hooks, components
and documentation links. `npm run typecheck` and `npm run lint` check types
and lint rules (on a fresh clone run `npx next typegen` first, so the
generated Next.js types it includes exist); `npm run build` checks the
production build. CI (`.github/workflows/ci.yml`) runs typecheck, lint,
`npm test` and every SQL fixture below on each pull request into `main`,
against a throwaway `postgres:17` service (no secrets, never the Supabase
project).

#### SQL fixtures

`supabase/tests/*.sql` are self-contained fixtures: each loads the migrations
it needs into an empty database, asserts, and rolls everything back. Some
fixtures deliberately stop at an older schema to test that migration stage.
CI runs them all; locally, run them with `psql` against a throwaway
`postgres:17` Docker container (port 54330, separate from the local stack,
never the remote) — the exact commands are in
[`scripts/README.md`](scripts/README.md#sql-fixtures). The seed fixtures are
`signius_sandbox_seed.sql`, `signius_live_seed.sql` and
`signius_seeds_head.sql`, which checks both seeds on the head schema (the
`head_*.sql` fixtures likewise test current behaviour on every migration).

### 5. Deploy (Netlify)

The repo carries `netlify.toml` (Next runtime) and three scheduled functions
under `netlify/functions/`, each a `POST` to the matching `/api/cron/*` route
with `Authorization: Bearer $CRON_SECRET`:
- `cron-reconcile` (every 15 min): applies scheduled workgroup-wallet changes
  and moves proposals along (opens voting when the discussion ends, records
  the result at the deadline, applies passed proposals, announces due
  milestones on Discord), freezes the tally document of every final
  proposal that lacks one and publishes frozen documents to the store each
  community chose, then scans every treasury address via Koios —
  confirms submitted transactions of every kind (tasks become `paid`,
  app-board tasks move to the Paid column, `block_time` is stamped),
  records incoming funds and tags transfers between the
  community's own wallets, imports outgoing transactions that carry a Guild
  Vault record this database did not build (the chain import), announces
  transactions built outside the app to the governance channel, retries
  GitHub write-backs, posts Discord payout notifications, purges API
  rate-limit counters older than a day, expired OAuth codes and refresh
  tokens, AI-client registrations nobody approved, and login challenges
  nobody signed in time, puts tasks left
  queued with no live payout back to payable, and lets the app-held
  co-signer check and sign co-signed transactions whose base signers are
  done.
- `cron-github-sync` (hourly): re-syncs up to five linked repos that were
  never synced or not synced for six hours; webhooks are never the source of
  truth.
- `cron-calls-sync` (every 5 min): takes one snapshot of the voice channel of
  every Discord call that is running, over a single short-lived gateway
  connection as the bot (`DISCORD_BOT_TOKEN`; needs Node 22, pinned in
  `netlify.toml`). There is no always-on bot process. It then reads Zoom's
  participant report for Zoom calls that ended at least 10 minutes ago, purges
  parked Zoom events older than 24 hours and the Zoom webhook replay guard's
  delivery hashes older than 10 minutes, creates the call of each new
  occurrence of a linked Meet meeting, and polls Google Meet's conference
  records for running and just-ended Meet calls. In production only, it also
  takes the bot out of Discord servers no community is connected to (an
  approval whose callback never arrived), once the bot has been there an hour.

Set the production Supabase URL, anon key, service-role key and legacy JWT
secret, `APP_URL` (`https://app.treasuryguild.com`), and random `CRON_SECRET`,
`OAUTH_STATE_SECRET`, `MCP_TOKEN_SECRET` and `COSIGNER_KEY_SECRET` values in
Netlify (`MCP_TOKEN_SECRET` is required: without it the AI-assistant
endpoints refuse to issue tokens; `COSIGNER_KEY_SECRET` is required too and
must be backed up: it encrypts the app-held co-signer keys, and without it
only the bypass path moves a co-signer treasury's funds).
Add the variables for the integrations you use from `.env.example`;
`SUPABASE_DB_URL` is for local tooling only and is not needed by the deployed app.
The schedules never
reach localhost; run the jobs by hand from `/dev` (a `DEV_WALLETS` wallet) or
with `curl -X POST -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/reconcile`.

## Budget management

Each workgroup has one effective budget setup across all its tokens
(`supabase/migrations/0019_budget_setup_history.sql`): recurring (monthly or
quarterly), explicit monthly, or explicit quarterly. Since migration 0036 a
treasury can own a setup of the same shape; it is consumed by the manual
payments made from that treasury (transfers excluded). The view dropdown only navigates; changing a setup is staged and
reviewed with the single **Save all changes** action.

Recurring changes create dated versions and preserve earlier amounts. Explicit
plans never fall back to recurring defaults. Cadence switches involving quarters
start at quarter boundaries, and setup switches cannot rewrite past periods.
Past amount corrections require a reason and affect only the selected period;
recurring corrections restore the previous amount in the next period. A later
scheduled setup blocks an earlier setup change, so it cannot be displaced
silently. The exception is a **backfill** (migration 0051): a save with no
setup in force at its start may begin in the past (with a reason) and runs
until the owner's first setup, ending on a quarter month when either is
quarterly. Future allocations superseded by a switch are shown in the review and
preserved in history. Saves are atomic per project and use revision checks;
partial failures keep drafts and retry only unsaved projects.

Migration preserves the original `workgroup_budgets` records and imports
unambiguous setups. Projects with multiple legacy modes/frequencies require
review and are excluded from totals where no resolved setup applies. Their
original amounts remain visible in project history. Earlier versions of legacy
recurring defaults cannot be reconstructed; the imported value is the earliest
known baseline. New changes record the actor, date, reason and previous values.
The editor shows the latest 20 changes; the database retains the complete audit.

`supabase/tests/budget_setup_history.sql` tests migration, archived records,
period boundaries, history, revisions and service-only access; the older
`supabase/tests/dated_budgets.sql` fixture covers migrations through 0018,
`supabase/tests/treasury_budgets.sql` the treasury-owned setups and
`supabase/tests/budget_backfill.sql` the backfill. Run them (and
`budget_reset.sql`) as described in [SQL fixtures](#sql-fixtures).

## Proposals and voting

Off until an admin turns a kind on under **Governance**
(`/c/[slug]/settings/governance`): decisions (polls), budgets, new workgroups
and tasks. With the budget kind on (**budget consent**), the Budgets page
proposes instead of saving, and the `guard_budget_consent` triggers refuse
every direct write to the budget tables, resets included; a passed proposal
applies its saves all or nothing. Rules are frozen onto each proposal, the
electorate is fixed when voting opens, and a ballot is a CIP-30 signature
over a text the server issues and rebuilds.

Proposals move on deadlines through the reconcile cron (and a nudge from the
open proposal page), so on a local stack run the reconcile job from `/dev`.
The code is in `src/lib/governance/` and migrations 0055-0057;
`supabase/tests/governance.sql` and `governance_workgroups_tasks.sql` cover
the RPCs (see [SQL fixtures](#sql-fixtures)). The user guide is
`src/content/docs/governance.mdx`.

Migrations 0059-0060 add the on-chain side: a final proposal's tally is
frozen once (`proposal_tally_documents`, optionally published to IPFS or GitHub
through `src/lib/storage/`), every payout and payment cites the proposals
behind it (`g` in its record) and is checked against the voted budgets
(`src/lib/governance/spendCheck.ts`; **warn** stores the problems on the
transaction, **refuse** fails the build), outgoing transactions built
outside the app are announced once, and each proposal's fingerprints are
anchored under label `190002` (`src/lib/cardano/anchorMetadata.ts`,
`proposal_anchors`), riding on the next payout or payment or on a fee-only
transaction from `POST /api/tx/build-anchor`; a Verify button re-checks the
record against the chain in the browser. Fixtures:
`supabase/tests/anchoring_groundwork.sql` and `anchors.sql`.

## Treasury templates and the co-signer

Migration 0061 gives a treasury one of four script shapes
(`src/lib/cardano/templates.ts`): plain, **clawback**
(`any[base, all[recovery, after(slot)]]`), **lock-until** (`all[base,
after(slot)]`) and **co-signer** (`any[all[base, sig(co)], all[every base
key]]`). Signers carry a group (`base`, `recovery`, `cosigner`); base signers
are admins and the treasury actors, the others must already be members.
Every transaction is built for one `spending_path` (`base`, `recovery`,
`cosigned`, `bypass`), resolved in `src/lib/tx.ts`, and only that path's
signers count on the sign, submit and reject routes. The co-signer is a
member or an app-held key (`src/lib/cosigner/`; generated at creation,
AES-256-GCM under `COSIGNER_KEY_SECRET`, never rotated) that signs only when
the check passes: the tx's outputs equal the stored rows, the record names
the same tasks or transfers, the strict budget check holds and every cited
proposal passed and was applied. Every run is recorded in
`cosigner_decisions`, a failure to sign after a pass included (`error`,
migration 0062). `supabase/tests/treasury_templates.sql` covers the
constraints.

Migration 0062 makes a transaction's state and its tasks change together:
`confirm_transaction` (the poller), `reject_transaction` and
`delete_pending_transaction` each do their task writes in the same database
step, and the reconcile cron puts back tasks left queued without a live
payout. Fixture: `supabase/tests/atomic_tx_state.sql`.

Migration 0063 turns the remaining check-then-write routes into single
database steps: a wallet may hold several open login challenges (asking for
one never replaces another's), a call's reward edit, delete and finalize
lock the call and check its attendance tasks in the same step
(`set_call_amounts`, `delete_call_without_tasks`, `finalize_call_at_reward`),
a task's assignees are replaced under its row lock
(`replace_task_assignees`), and a host connection is saved with its tokens
(`save_call_integration`). Fixture: `supabase/tests/route_hardening.sql`.

Migrations 0064 and 0065 back the agent API's writes: the rows an
assistant's confirmed draft creates (`proposals`, `transactions`, `tasks`,
`calls`) carry a unique `agent_draft_id`, so confirming the same draft twice
creates one row (`create_proposal_from_draft` for proposals). Fixtures:
`supabase/tests/agent_proposal_drafts.sql`, `supabase/tests/agent_drafts.sql`.

## How payouts work

1. Tasks become **payable** when a GitHub issue has both the payable label
   and the configured Projects v2 import status, a native task enters a
   payable column, or a call manager creates attendance tasks. To build a
   payout, every selected task needs a bounty, at least one assignee and a
   wallet for every assignee; each receives the full bounty.
2. An admin, a treasury signer, or a lead of every selected workgroup opens
   **Payday**, selects tasks, and builds the batch tx.
   Tasks flip to `queued`; one pending tx per treasury at a time.
3. Signers of the transaction's spending path open the transaction page and
   **sign with their CIP-30 wallet** (partial signatures; witnesses are
   verified against the tx body hash and merged server-side without
   re-encoding the body). On a co-signer treasury the app-held co-signer
   signs once the base rule is met and its check passes; a member
   co-signer reads the check on the page and signs like any signer.
4. The final signature triggers submission; any signer of that treasury can
   retry **Submit to chain** if it fails. The reconcile cron confirms it
   on-chain, marks tasks `paid` (app-board tasks move to the board's Paid
   column), and comments the tx hash back on GitHub issues with a `paid`
   label, moving the issue to the repo's Paid status column.
5. Overpaid? The contributor sends ADA back to the treasury address; the
   refund shows up under **Incoming** for matching against the payout.

A payout or payment that reached the chain without this database knowing
(another deployment, a local reset) comes back through the **chain import**
(`src/lib/chainImport/`, migration `0045_chain_import.sql`): after every
treasury poll, an outgoing transaction with a Treasury Guild record is rebuilt
from its own CBOR as confirmed `transactions` + `payouts` / `payments` rows,
creating missing tasks as paid stubs (`Imported task #N`). A transaction is
imported completely or not at all; what cannot be resolved (an unknown
workgroup name, a task number already taken) is held on the Treasury page for
an admin. `supabase/tests/chain_import.sql` covers the RPC.

## On-chain metadata (label 190001)

Two record types share the label; both are built only in
`src/lib/cardano/` (`metadata.ts`, `paymentMetadata.ts`) and read back from
the tx CBOR. Every string is enforced ≤64 bytes (Cardano metadatum limit),
amounts are exact decimal strings in display units, and no addresses,
handles or personal names are added automatically — the recipient is the
output's address. Workgroup names are included in payouts, and a payment's
optional memo is public text supplied by its author.

**Task payout (v3)** — `w` workgroup names, `b` budget periods (`YYYY-MM`
or `YYYY-Qn`), `k` asset tickers; `p` lists, per output, the tasks it pays as
`[taskNumber, wIndex, bIndex, [amounts aligned to k]]`. An optional `g`
cites the proposals behind the spend, `[[proposalNumber, contentHash,
[taskNumber…]], …]` (a payment's `g` entries have no task list):

```json
{
  "v": 3, "src": "treasury-guild", "c": "signius",
  "w": ["Dev", "Design"],
  "b": ["2026-05", "2026-Q2"],
  "k": ["ADA", "GVT"],
  "p": [[0, [[12, 0, 0, ["150", "250"]]]], [1, [[15, 1, 1, ["40"]]]]]
}
```

**Manual payment (v1)** — marked `t: "payment"` and has no `p`. `b` is the
one budget period charged (empty when every output is a transfer), `m` an
optional memo, `o` lists per output `[outputIndex, [amounts aligned to k],
flag]` with flag `0` = spending charged to the paying treasury's budget and
`1` = transfer to a sibling treasury (counts against no budget). A transfer
of 188 ADA and 50 000 GVTT to another of the community's treasuries:

```json
{
  "v": 1, "src": "treasury-guild", "t": "payment", "c": "signius",
  "b": "",
  "k": ["ADA", "GVTT"],
  "m": "Workgroup Budget",
  "o": [[0, ["188", "50000"], 1]]
}
```

**Proposal anchors (label 190002)** — built only in
`src/lib/cardano/anchorMetadata.ts`: `{v: 1, src, c, a}` with one entry per
proposal step, `[n, "proposed", contentHash, rulesHash]`, `[n, "opened",
electorateHash]` and `[n, "closed", state, tallyHash, [electorate, ballots,
[[choice, count]…]], [store, locator]?]`; numbers, states and hashes only.

The transaction page shows each record raw with a legend of its keys
(`src/lib/cardano/metadataLegend.ts`); the user docs under `/docs` are the
long-form reference.
