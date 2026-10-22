# Signius seeds

Two opt-in seeds for the **Signius** preprod community, both keyed to its
submitted/confirmed **Test Token (GVTT)** mint; the sandbox requires
migrations through `0033_paid_columns.sql` (it seeds a `marks_paid` column),
the live seed through `0035_workgroup_treasury_assignments.sql`; in practice
run them on a fully migrated database. They are deliberately separate so that
payout-building practice never rewrites real transaction history:

| Seed | Purpose | What a run does |
|---|---|---|
| `signius_sandbox.sql` | Build (and delete) payout transactions, **never submit them** | Wipes the previous sandbox and reseeds identical scenarios |
| `signius_live.sql` | Build, sign **and submit** real preprod payouts | Adds one new, unique batch to each of the two live workgroups; never deletes anything |

## Running (local stack, the default)

```powershell
npm run seed:sandbox
npm run seed:live
```

The npm commands run the file with `psql` against the local Supabase
database (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`, the
local stack's DB port from `supabase/config.toml`). Start the stack first
(`npm run db:start`); `psql` fails to connect when it is not running.
Output: the seed's `NOTICE` line plus one
summary row, `this_run` (what the seed just did) and the current state of the
seeded workgroup.

The seeds need the Signius community, its members and the confirmed GVTT
mint. Locally those come from the remote data snapshot: `npm run db:snapshot`
then `npm run db:reset` (see [`scripts/README.md`](../../scripts/README.md)).
A local database without the snapshot fails with "Signius community not
found".

A live batch seeded locally can still be built, signed and submitted for real
on preprod; the transaction record then lives only in the local database.

## Seeding the remote project (rare)

There is deliberately no npm alias and no confirmation prompt for this any
more — run the file through the Supabase CLI against the **linked** project
by hand, and double-check `supabase migration list` shows the Treasury
Guild project as the remote before you do (the sandbox seed wipes the
remote `[TEST]` workgroups, the live seed appends real history):

```powershell
supabase db query --linked -f supabase/seeds/signius_sandbox.sql
supabase db query --linked -f supabase/seeds/signius_live.sql
```

This goes over the Management API (`NOTICE` lines are dropped). To see the
notices, use `psql` with the remote connection string instead (Project
Settings → Database, e.g. kept as `SUPABASE_DB_URL` in `.env.remote`):
`psql <connection string> -X -v ON_ERROR_STOP=1 -f supabase/seeds/signius_sandbox.sql`.
The service-role key cannot run SQL, so it is not an alternative.

Both seeds are a single atomic statement: any error rolls the whole run back.
They only target `signius` on testnet and refuse missing or ambiguous mints,
conflicting GVTT mappings, and a community without members.

Seeded ids are deterministic (derived from the namespace, community and task
slot) and shaped like RFC 4122 v4 uuids, because the API validates ids with
`z.uuid()`, which rejects a plain `md5(...)::uuid`. The first seed version used
plain md5 ids, so saving one of its tasks failed with "taskId: Invalid UUID";
the sandbox reset removes those three legacy workgroups on its first run.

## Sandbox: `signius_sandbox.sql`

Every run **deletes and recreates** the sandbox:

- The three native workgroups **[TEST] Signius Community**, **[TEST] Signius
  Product QA** and **[TEST] Signius Content** keep their deterministic ids (so
  their budgets and routing survive). Community and Product QA are routed
  to the GVTT treasury; Content has no routing (payable from any wallet).
- All of their tasks, assignees and board columns are removed and reinserted.
  Task numbers are issued as max + 1, so the freed numbers are handed out
  again; that is fine because sandbox numbers never reach the chain.
- Pending or rejected transactions that pay only sandbox tasks are deleted too
  (their payout rows cascade), so a half-finished build never blocks a reseed.
- Archived sandbox workgroups are restored first.

The reset **refuses** if any sandbox task has on-chain history (a submitted or
confirmed transaction, a `paid`/`reconciled` state or a `paid_tx_hash`), or if
a transaction mixes sandbox tasks with other tasks. Never submit a transaction
built from sandbox tasks; use the live seed for that.

Each run creates **49 tasks**, 12 per month from **June through September
2026** plus one extra, across five columns (To Do, In Progress, Done, Audited,
Paid — the last one stays empty; the confirm poller fills it).
Rewards total **41,500 GVTT**. The 12 Audited tasks are payable and each
carries one scenario, described in its body:

| Workgroup | Scenario |
|---|---|
| Community | Baseline: one assignee, budget month set |
| Community | Two assignees: two outputs with identical amounts, no budget month (build stamps the current period: the month here, the quarter for Product QA tasks) |
| Community | No assignee: excluded from the default selection, build reports "no assignees" |
| Community | ADA + GVTT in one output (2 ADA plus the reward) |
| Product QA | Same wallet as the Community baseline: rewards aggregate into one output; budget period set to Q3 2026 (stored as `2026-07-01`, written on-chain as `2026-Q3`) |
| Product QA | Three assignees: three outputs |
| Product QA | GitHub login `seed-unlinked-tester` with no wallet plus one linked wallet: blocked until the login gets a wallet in the task dialog (on real GitHub tasks, unassigning on GitHub also clears it) |
| Product QA | Extra `BONUS` field with no token mapping: connect it on Payday or deselect |
| Content | ADA only (1.5 ADA) |
| Content | Archived while payable: hidden until restored |
| Content | Baseline from an unrouted workgroup, budget month set |
| Content | Baseline from an unrouted workgroup, no budget month |

Assignees come from the community's members (owner first, then admins); slots
wrap when there are fewer than three members. In Progress and Done tasks carry
one assignee each, To Do tasks none. The extra card, **Oversized reward** in
Product QA's Done column, has a 999,999,999 GVTT reward: move it to Audited to
test an insufficient-funds failure without breaking the default build.

### Budgets

The first run also sets up a budget on each sandbox workgroup, written through
the app's own `save_budget_setup` function by the owner wallet, so the Budgets
page, the budget dashboard and the task dialog's period picker have something
to show. One workgroup per setup mode:

| Workgroup | Setup | Amounts |
|---|---|---|
| Community | Recurring monthly from June 2026 | 4,000 GVTT + 5 ADA per month |
| Product QA | **Quarterly plan** | Q2 2026: 12,000 GVTT + 10 ADA · Q3 2026: 13,500 GVTT + 10 ADA |
| Content | Monthly plan, June–September 2026 | 3,500 / 4,000 / 4,500 / 5,000 GVTT + 5 ADA |

Budgets are seeded **only when the workgroup has no setup yet**. Edits and
resets made in the app survive a reseed (a reset is blocked while payable
tasks exist anyway). The summary reports `budgetedWorkgroups` for the run
and `budgetSetups` for the current state.

When Signius has the **budget proposal kind on** (Settings → Governance),
budgets change only by proposal, so neither seed writes one: tasks are seeded
as usual, a workgroup without a setup stays without one, and the summary
reports `budgetsByProposal: true`. Propose the budget in the app, or turn the
kind off before the first run.

## Live: `signius_live.sql`

Every run **adds one batch** to each of the two persistent native live
workgroups, so there is always something to pay from two wallets at once (a
treasury allows only one pending payout transaction):

| Workgroup | Budget cadence | Periods per batch | Tasks per batch | Created routed to |
|---|---|---|---|---|
| **[LIVE] Signius Payout Runs** | monthly | the last five months | 15 | the treasury that minted GVTT |
| **[LIVE] Signius Quarterly Runs** | quarterly | the last two quarters | 6 | the oldest Signius preprod treasury the monthly workgroup does not pay from (the mint treasury when there is no other) |

Routing is written once, when the workgroup is created (timeline row
included); rerouting one in the app to another Signius preprod treasury or to
"any wallet" is respected. A database that already has the monthly workgroup
simply gains the quarterly one on the next run.

Each batch is the same three scenarios for each period (the current one and
the ones before it), titled `[LIVE YYYY-MM-DD HH:MM] YYYY-MM …`
(`… YYYY-Qn …` for the quarterly workgroup) and carrying the full batch id in
their bodies. A quarter's `budget_month` is its first month:

| Task | Amounts | Assignees | Budget period |
|---|---|---|---|
| Token reward | 1 GVTT | member 1 | the task's period |
| Token and ADA reward | 2.5 GVTT + 1.5 ADA | members 1 and 2 | the task's period |
| ADA reward | 0.5 ADA | member 3 | the task's period; none in the current period (stamped at build) |

Per period that is 6 GVTT + 3.5 ADA: the monthly batch pays 30 GVTT +
17.5 ADA and the quarterly one 12 GVTT + 7 ADA in bounties, each across three
outputs (one per member wallet, rewards aggregate).

Build each batch on Payday, sign with the treasury's signers and submit it.
The seed never deletes or edits earlier batches, so paid tasks keep their
`paid_tx_hash` and the boards accumulate real history. Earlier batches that
are still unpaid join the next build by default; deselect them if you want one
transaction per batch. The summary carries run totals (`insertedTasks`,
`assigneeRows`, `mintTreasury`) and, under `workgroups.runs` and
`workgroups.quarterly`, each workgroup's `insertedTasks`, `earlierUnpaidTasks`,
`routedTreasury` and whether that treasury (any Signius treasury when
unrouted) already has a pending transaction. The seed refuses to run if either
live workgroup is archived, no longer native, or routed to a treasury outside
the Signius preprod community.

Each paying treasury needs some tADA on top of the GVTT: a batch pays its ADA
outright plus the min-UTxO ADA riding on every token output. The second
treasury starts empty: send it GVTT and tADA from the mint treasury with a
transfer on the Payments page.

The first run also gives each live workgroup a recurring budget of
25 GVTT + 10 ADA per period (monthly or quarterly) starting at the earliest
seeded period (per-workgroup summary keys `budgeted`, `firstPeriod`,
`lastPeriod`); later runs leave whatever budget is in place untouched. Every
batch adds to the same periods, so after a few runs a period exceeds its
budget: raise the budget in the app when that happens.

### Earlier history: `signius_live_history.csv`

A sample [previous-wallet history](../../src/content/docs/treasury.mdx) CSV
for the two live workgroups, covering the periods before their first seeded
payouts: January–April 2026 for **[LIVE] Signius Payout Runs** and Q1 2026
for **[LIVE] Signius Quarterly Runs**. It mirrors a live batch (token reward,
token + ADA reward to two members, ADA reward) with slightly varied ADA and
GVTT amounts, paid to the same three member wallets (`userId` = the last six
characters of each address). Import it in the app: **Treasury → Payment
history**, add a previous wallet, choose the file. It is not a SQL seed and no
script loads it.

### Funding schedule: `signius_funding_schedule.csv`

A sample funder release plan for trying [funding sources](../../src/content/docs/funding.mdx), shaped like the
SNET plan that inspired the feature: one row per month of 2026 under a `release_date` column, each month 1.5% below
the last (225 GVTT → 221.625 → 218.300625 …, rounded to 6 decimals), with a matching ADA column and a sister
community's GVTT column to skip. In the app: **Funding → Add funding source**, then **Import CSV** on it, map
`signius_gvtt` to GVTT and `signius_ada` to ADA, and skip `sister_community_gvtt`. It is not a SQL seed.

## Verifying the seeds

Run the seed fixtures with `psql` against a throwaway `postgres:17`
container with Docker (port 54330, separate from the local Supabase stack) —
the exact commands are in
[`scripts/README.md`](../../scripts/README.md#sql-fixtures). The seed
fixtures are `signius_sandbox_seed.sql`, `signius_live_seed.sql` and
`signius_seeds_head.sql` in `supabase/tests/`; CI runs every SQL fixture in
the repository on each PR.
The first two fixtures load the migrations their seed requires (through
`0033` for the sandbox, `0035` for the live seed), seed, assert the scenarios, rerun to
check reset/append behaviour, exercise the expected rejections, and roll
everything back. `signius_seeds_head.sql` loads every migration and checks
that both seeds still load, rerun and coexist on the head schema (including
the budget-consent behaviour above). Neither the remote project nor the
local stack is involved.
