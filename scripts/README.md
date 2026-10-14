# Supabase CLI — command reference

## Daily loop: local first, push when happy

Development and manual testing run against a **local Supabase stack** in
Docker (Postgres 17 + PostgREST + Studio) built from `supabase/migrations/`
and optionally seeded with a data snapshot of the remote project.
`scripts/local.ps1` never writes to the remote. `db push` deploys schema
changes; running the app or seeds against the remote also writes data.

Prerequisites: Node.js 22+, npm, PowerShell, Docker Desktop and the Supabase
CLI on PATH. Install PostgreSQL 17 client tools (`psql` for seeds and SQL
fixtures, `pg_dump` for snapshots via a database URL). Run `npm ci` and copy
`.env.example` to `.env` once before the first-time setup below.

| Command | What it does | Touches remote? |
|---|---|---|
| `npm run db:start` | Starts the stack (Docker Desktop must be running). A brand-new database also gets all migrations and the snapshot. | no |
| `npm run db:snapshot` | Dumps the remote **data** (not schema) to the gitignored `supabase/seeds/local/remote_snapshot.sql`, so Signius, its treasury, members and the GVTT mint exist locally. Skips `auth_nonces` and the raw GitHub `webhook_events`. Uses `pg_dump` with `SUPABASE_DB_URL` from `.env.remote`; falls back to `supa.ps1 db dump --linked`. | read only |
| `npm run db:reset` | Drops the local DB, applies every migration from scratch, loads the snapshot. The check that a new migration applies cleanly. | no |
| `npm run db:env` | Rewrites the Supabase lines of `.env` with the local stack's URL, keys and JWT secret (from `supabase status`). The first run saves the previous values to `.env.remote`. | no |
| `npm run db:status` / `npm run db:stop` | Local URLs and keys / stop the containers. | no |
| `npm run seed:sandbox` / `seed:live` | Signius seeds against the **local** DB (psql, NOTICEs shown). The `:remote` variants ask you to type `remote` first; see [`supabase/seeds/README.md`](../supabase/seeds/README.md). | no |
| `npm run dev` / `npm run dev:remote` | App against local (`.env`) / against the remote (`.env.remote` overlaid). | dev:remote |
| `npm run seed:test` | The three Signius seed fixtures (`seed-tests.ps1 -Filter signius`: sandbox, live and the head-schema check) in a separate throwaway `postgres:17` container (port 54330). `.\scripts\seed-tests.ps1` with no `-Filter` runs every `supabase/tests/*.sql`; `-Port` / `-Image` override the defaults. | no |

The stack's ports come from `supabase/config.toml`: API 54321, DB 54322,
Studio http://127.0.0.1:54323. Only Postgres, PostgREST, Auth and Studio are
enabled; realtime, storage, edge runtime, analytics and mail are off.

First-time setup:

```powershell
npm run db:start        # pulls images on first run
npm run db:env          # .env -> local; old values -> .env.remote
# put the remote connection string (Project Settings -> Database) into
# .env.remote as SUPABASE_DB_URL, then:
npm run db:snapshot
npm run db:reset
npm run seed:sandbox
npm run dev
```

Without access to remote data, skip `db:snapshot`, `db:reset` and the
Signius seed: `db:start` creates the schema, then `db:env` and `dev` let you
create your own community. Signius seeds require its existing community,
members and GVTT mint in a snapshot.

`npm run dev` is plain `next dev`, so process variables and higher-priority
files such as `.env.local` can override `.env`. `db:env` rewrites only `.env`;
`dev:remote` loads non-empty `.env.remote` values into its process before
starting Next.js.

`start`, `stop`, `reset`, `status` and `env` are Docker-only and never
authenticate with a Supabase account. Re-run `db:snapshot` + `db:reset`
whenever you want fresh remote data locally (a new member, mint, …).

**Block the stack from your network (once).** Docker publishes the ports on
`0.0.0.0`, so Postgres (`postgres:postgres`), Studio (no login) and the API
(well-known demo keys) are reachable by anyone on the same Wi-Fi unless Windows
blocks them, and the local database holds real member wallets from the
snapshot. The CLI cannot bind to loopback only, so add a firewall rule from an
**elevated** PowerShell; `npm run db:start` warns until it exists:

```powershell
New-NetFirewallRule -DisplayName 'Treasury Guild local Supabase (block LAN)' `
  -Direction Inbound -Protocol TCP -LocalPort 54320-54330 -RemoteAddress Any -Action Block
```

Loopback traffic is never filtered, so the app on this machine keeps working.

Things to keep in mind while testing locally:

- A transaction built from local data and submitted goes to the real
  chain for that community (mainnet or preprod); only the database record is
  local. The Signius seeds use preprod. **`npm run db:reset`
  destroys such records** (it reloads the remote snapshot). Before a reset,
  check for local-only history — `select tx_hash, state from transactions
  where created_at > '<snapshot date>'` — and either take a
  `db dump --local --data-only` first or apply the new migration forward with
  `.\scripts\supa.ps1 migration up --local` instead. A lost payout can be
  rebuilt by the app's chain import on the next treasury sync, with
  `scripts/recover-payout-tx.mjs` as a manual fallback (below).
- The reconcile, GitHub-sync and calls-sync crons are Netlify schedules and
  never reach localhost. Run them by hand when you need confirmation locally: the
  "Scheduled jobs" section of `/dev` (a wallet in `DEV_WALLETS`) has a
  "Run now" button per job and shows the result, or from a shell:
  `curl -X POST -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/reconcile`.
  Reconciling a GitHub-sourced task still comments on the real issue, so
  prefer the native seed tasks.

## The remote project

Authenticated remote Supabase CLI calls go through `scripts/supa.ps1`, never
bare `supabase`. Snapshot and seed scripts can instead use `pg_dump` / `psql`
with `SUPABASE_DB_URL`. The wrapper sets `SUPABASE_ACCESS_TOKEN` for the Treasury Guild
account before forwarding all arguments, so the globally stored CLI login
(which belongs to another project) is never touched or overwritten.
`scripts/local.ps1` uses the wrapper too when it exists (harmless for the
local commands, required for `db dump --linked`).

```powershell
.\scripts\supa.ps1 <any supabase args>
# is exactly
supabase <any supabase args>   # ...but authenticated as the Treasury Guild account
```

Never run `supabase login` or `supabase logout` in this repo. That would
change the global login used by the other project.

## The wrapper

`scripts/supa.ps1` is **gitignored** because it holds a personal access token.
On a fresh clone, recreate it:

```powershell
# scripts/supa.ps1
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."   # Treasury Guild account → Account → Access Tokens
supabase @args
```

Also gitignored: `supabase/.temp/` (the link cache, holds the project ref and
pooler URL) and `supabase/.branches/`. After recreating the wrapper, run the
link command below once to rebuild `.temp`.

## Setup (once per machine)

| Command | What it does |
|---|---|
| `.\scripts\supa.ps1 projects list` | Confirms the token works and shows the Treasury Guild project ref. |
| `.\scripts\supa.ps1 link --project-ref <ref>` | Links this repo to the remote project. Prompts for the database password (Project Settings → Database). Writes `supabase/.temp/`. |
| `.\scripts\supa.ps1 status` | Shows what is linked / what is running locally. |

## Migrations (the day-to-day commands)

Migrations live in `supabase/migrations/` and are numbered by hand
(`0001_core.sql`, `0002_…`, and so on). Keep that convention: create the next
file yourself rather than using `migration new`, which generates a timestamp
prefix.

| Command | What it does |
|---|---|
| `.\scripts\supa.ps1 db push` | Applies every migration not yet recorded on the remote. Runs each one as a transaction. This is the normal deploy step. |
| `.\scripts\supa.ps1 db push --dry-run` | Lists which migrations *would* be applied without running them. Use before a real push. |
| `.\scripts\supa.ps1 db push --include-all` | Also pushes migrations whose version is older than the latest applied one (needed if a file was added out of order). |
| `.\scripts\supa.ps1 migration list` | Side-by-side view of local files vs. versions recorded on the remote. First stop when a push refuses to run. |
| `.\scripts\supa.ps1 migration repair --status applied <version>` | Marks a version as applied on the remote without running it (e.g. the SQL was pasted in the dashboard). |
| `.\scripts\supa.ps1 migration repair --status reverted <version>` | Removes a version from the remote history so `db push` will run it again. |
| `.\scripts\supa.ps1 migration new <name>` | Creates a timestamped empty migration file. Avoid here — rename to the `NNNN_name.sql` convention if you use it. |

Typical flow for a schema change:

```powershell
# 1. write supabase/migrations/00NN_<name>.sql by hand
.\scripts\supa.ps1 migration up --local # 2. applies only the pending file(s) to the running local DB
#    (npm run db:reset also proves it applies from scratch, but wipes any
#     local-only transaction history — see "Things to keep in mind" above)
npm run seed:sandbox                    # 3. test in the app on npm run dev
.\scripts\seed-tests.ps1                # 4. every SQL fixture (add one for the new rules; npm run seed:test covers only the seed fixtures)
.\scripts\supa.ps1 db push --dry-run    # 5. check only 00NN is pending
.\scripts\supa.ps1 db push              # 6. apply to the remote — the only remote write in the loop
.\scripts\supa.ps1 migration list       # 7. confirm remote history matches
```

## Inspecting the remote schema

| Command | What it does |
|---|---|
| `.\scripts\supa.ps1 db diff --linked` | Diffs the linked remote against local migrations. Prints SQL for any drift (dashboard edits that never became a migration). |
| `.\scripts\supa.ps1 db diff --linked -f <name>` | Same, but writes the diff into a new migration file. Rename it to the numbered convention afterwards. |
| `.\scripts\supa.ps1 db pull` | Pulls the remote schema into a migration file. Only for bootstrapping; this repo already has a full migration history. |
| `.\scripts\supa.ps1 db dump --linked -f schema.sql` | Dumps the remote schema (no data) to a file. |
| `.\scripts\supa.ps1 db dump --linked --data-only -f data.sql` | Dumps remote data only. |
| `.\scripts\supa.ps1 db lint --linked` | Runs plpgsql_check style lints against remote functions (e.g. `add_signature`, `jwt_wallet`). |
| `.\scripts\supa.ps1 db query --linked "<sql>"` / `-f file.sql` | Runs SQL on the remote over the Management API (no DB password). Multi-statement files and `DO` blocks work; only the last result set comes back and `NOTICE` lines are dropped. |
| `.\scripts\supa.ps1 inspect db table-sizes --linked` | Table sizes on the remote. Other `inspect db` subcommands: `index-usage`, `long-running-queries`, `bloat`, `cache-hit`. |

## Generating TypeScript types

```powershell
.\scripts\supa.ps1 gen types typescript --linked > src/lib/supabase/database.types.ts
```

This is optional: the app hand-types its rows in `src/lib/db/types.ts` and
does not consume this generated file. Update the affected row types and
query helpers after schema changes; generate a file only for inspection or
as part of an intentional change to the typing approach.

## Local stack: raw CLI equivalents

`npm run db:*` wraps these (see the top of this file). Useful on their own:

| Command | What it does |
|---|---|
| `.\scripts\supa.ps1 db reset --local` | Same as `npm run db:reset`. |
| `.\scripts\supa.ps1 db diff --local` | Diffs the local DB against migrations (drift from Studio edits). |
| `.\scripts\supa.ps1 db dump --local --data-only -f out.sql` | Dumps local data, e.g. to keep a hand-made scenario. |
| `.\scripts\supa.ps1 status -o env` | The raw values `npm run db:env` writes into `.env`. |
| `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres` | Direct SQL against the local DB. |

## Recovering a payout record from the chain

The app now does this by itself: after every treasury poll (the 15-minute
reconcile job and the on-visit sync) the **chain import**
(`src/lib/chainImport`, migration 0045) turns an outgoing transaction that
carries a Treasury Guild label-190001 record into the rows the app would have
written, creating missing tasks, and holds what needs a decision on the
Treasury page. The script below remains the manual fallback for a single
payout hash when no app server is running against that database; unlike the
import it never creates tasks.

`scripts/recover-payout-tx.mjs` rebuilds the database side of a payout that
Treasury Guild built and submitted but whose rows are gone (a local reset after a
locally submitted `seed:live` batch, a failed bookkeeping write after submit):

```powershell
node --env-file=.env scripts/recover-payout-tx.mjs <txHash> [<txHash> ...] [--remote]
```

It needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the
env file (`KOIOS_API_KEY` and the `KOIOS_BASE_URL_*` overrides are optional).

It reads the transaction from Koios (body CBOR, outputs, label-190001
metadata), maps every metadata entry to its output by `tx_index`, checks the
amounts against what is on-chain, and writes the `transactions` row
(Confirmed, with the real CBOR and the signers found in the witness set), the
`payouts` rows and the tasks' paid state, then removes the matching
`external_txs` entry the poller may have recorded. The tasks must already
exist with the numbers the metadata names and be payable with the recipient
among their assignees — for a lost `seed:live` batch, run `npm run seed:live`
again first (task numbers are reissued in order). Anything that does not line
up aborts that hash without writing; a known hash is a no-op. Targets the
local stack (a `127.0.0.1`/`localhost` Supabase URL); `--remote` is required
to write anywhere else, e.g. `node --env-file=.env.remote … --remote`.

## Secrets and edge functions

The app has no Supabase edge functions (crons are Netlify scheduled functions
and all secrets live in Netlify / `.env`), so these are listed only for
completeness:

| Command | What it does |
|---|---|
| `.\scripts\supa.ps1 secrets list` | Lists secrets stored on the remote project (for edge functions). |
| `.\scripts\supa.ps1 secrets set KEY=value` | Sets one. |
| `.\scripts\supa.ps1 functions list` | Lists deployed edge functions (expect none). |

## Troubleshooting

- **`npm.ps1 cannot be loaded because running scripts is disabled`** — use
  `npm.cmd` in place of `npm` in PowerShell. For a direct helper invocation,
  use `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/seed-tests.ps1`
  (or the relevant script path and arguments); the npm database scripts
  already launch their helpers this way.

- **"Access token not provided" / wrong project shown** — you ran bare
  `supabase`. Re-run through the wrapper.
- **`db push` says remote is ahead / version mismatch** — run
  `migration list`, then `migration repair` the offending version.
- **Link prompts for a password every time** — the CLI caches it in the OS
  keyring; pass `-p <password>` to `link` once if the keyring is unavailable.
- **`.temp/` missing after clone** — expected. Re-run `link`.
- **Need the JWT secret / API keys** — local: `npm run db:env` writes them.
  Remote: Project Settings → API in the dashboard; see the Supabase section
  of the root README.
- **`npm run db:snapshot` asks for a password / fails to connect** — set
  `SUPABASE_DB_URL` in `.env.remote` to the connection string from Project
  Settings → Database (use the session pooler string if direct IPv6 is not
  reachable), password included.
- **`npm run seed:sandbox` says it cannot reach the local database** — Docker
  Desktop is not running or the stack is stopped: `npm run db:start`.
- **App shows "not configured" errors after `db:env`** — restart `npm run
  dev`; Next reads `.env` at startup only.
