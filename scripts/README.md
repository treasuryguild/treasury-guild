# Supabase CLI — command reference

## Daily loop: local first, push when happy

Development and manual testing run against a **local Supabase stack** in
Docker (Postgres 17 + PostgREST + Studio) built from `supabase/migrations/`
and optionally seeded with a data snapshot of the remote project. Everything
goes through the **Supabase CLI directly** — there are no helper scripts in
this repo. The `npm run db:*` / `seed:*` commands in `package.json` are thin
aliases over `supabase` / `psql` invocations; anything beyond them is run by
hand from this page. Local commands never write to the remote; `supabase db
push` deploys schema changes, while running the app or seeds against the
remote also writes data.

Prerequisites: Node.js 22+, npm, Docker Desktop and the Supabase CLI on PATH.
Install PostgreSQL 17 client tools (`psql` for seeds and SQL fixtures,
`pg_dump` is not needed directly — `supabase db dump` wraps it). Run
`npm ci` and copy `.env.example` to `.env` once before the first-time setup
below.

## CLI setup (once per machine)

```powershell
supabase login                     # browser sign-in; token stored by the CLI
supabase projects list             # confirms auth; shows this project's ref
supabase link --project-ref <ref>  # links this repo (writes supabase/.temp/)
```

`supabase login` stores one token globally on the machine. On a machine that
also serves other Supabase projects under a different account, prefer a
per-session token instead of switching the global login:

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."   # Account → Access Tokens; the CLI reads it
```

| Command | What it does | Touches remote? |
|---|---|---|
| `npm run db:start` (`supabase start`) | Starts the stack (Docker Desktop must be running). A brand-new database also gets all migrations and the snapshot. | no |
| `npm run db:stop` (`supabase stop`) | Stops the local containers (volumes kept). | no |
| `npm run db:status` (`supabase status`) | Local URLs and keys. `-o env` prints them as `KEY=value` for `.env`. | no |
| `npm run db:reset` (`supabase db reset --local`) | Drops the local DB, applies every migration from scratch, loads the snapshot from `supabase/seeds/local/` (config.toml `[db.seed].sql_paths`). The check that a new migration applies cleanly. | no |
| `npm run db:migrate` (`supabase migration up --local`) | Applies only pending migrations to the running local DB (keeps data). | no |
| `npm run db:snapshot` (`supabase db dump --linked --data-only …`) | Dumps the remote **data** (not schema) to the gitignored `supabase/seeds/local/remote_snapshot.sql`, so Signius, its treasury, members and the GVTT mint exist locally. Skips `auth_nonces` and the raw GitHub `webhook_events`. Needs the linked project (above). Read only. | read only |
| `npm run seed:sandbox` / `seed:live` | Signius seeds against the **local** DB via `psql` (NOTICEs shown). Remote seeding is a manual CLI command — see [`supabase/seeds/README.md`](../supabase/seeds/README.md). | no |
| `npm run dev` | App against local (`.env`). Running against the remote is a manual env overlay — see below. | no |

The stack's ports come from `supabase/config.toml`: API 54321, DB 54322,
Studio http://127.0.0.1:54323. Only Postgres, PostgREST, Auth and Studio are
enabled; realtime, storage, edge runtime, analytics and mail are off.

First-time setup:

```powershell
supabase login
supabase link --project-ref <ref>
npm run db:start        # pulls images on first run
supabase status -o env  # copy the Supabase values into .env (mapping below)
npm run db:snapshot     # remote data -> supabase/seeds/local/ (create the folder first if needed)
npm run db:reset        # migrate from scratch + load the snapshot
npm run seed:sandbox
npm run dev
```

Pointing `.env` at the local stack is a manual copy from
`supabase status -o env`:

| `supabase status -o env` | `.env` variable |
|---|---|
| `API_URL` | `NEXT_PUBLIC_SUPABASE_URL` |
| `ANON_KEY` (or `PUBLISHABLE_KEY`) | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `SERVICE_ROLE_KEY` (or `SECRET_KEY`) | `SUPABASE_SERVICE_ROLE_KEY` |
| `JWT_SECRET` | `SUPABASE_JWT_SECRET` |
| `DB_URL` | `SUPABASE_DB_URL` (local tooling only; the app never reads it) |

Keep the remote project's values (Project Settings → API, plus the direct or
session-pooler connection string from Project Settings → Database) in
`.env.remote` yourself if you want them on disk; it is gitignored and only
you read it — no command loads it automatically any more.

Running the dev server against the remote: load `.env.remote` into the
process env first (Next never overrides variables already set), e.g. in
PowerShell:

```powershell
Get-Content .env.remote | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') { Set-Item "env:$($Matches[1].Trim())" $Matches[2].Trim() }
}
npm run dev
```

Without access to remote data, skip `db:snapshot` and `db:reset`: `db:start`
creates the schema, then copy the local values into `.env` and `npm run dev`
lets you create your own community. Signius seeds require its existing
community, members and GVTT mint in a snapshot.

`npm run dev` is plain `next dev`, so process variables and higher-priority
files such as `.env.local` can override `.env`.

Before loading a snapshot with `db:reset`, check the dumped file starts its
data section with `set session_replication_role = replica;` (the CLI's
pg_dump output normally does); if it does not, add that line at the top —
the snapshot must load with triggers and FK checks off, or task-number and
lifecycle guards fire while rows are copied in. The dump is taken with
`-s public`, so the remote's `supabase_migrations` history is never in it.

Re-run `db:snapshot` + `db:reset` whenever you want fresh remote data
locally (a new member, mint, …).

**Block the stack from your network (once).** Docker publishes the ports on
`0.0.0.0`, so Postgres (`postgres:postgres`), Studio (no login) and the API
(well-known demo keys) are reachable by anyone on the same Wi-Fi unless Windows
blocks them, and the local database holds real member wallets from the
snapshot. The CLI cannot bind to loopback only, so add a firewall rule from an
**elevated** PowerShell:

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
  `supabase db dump --local --data-only` first or apply the new migration forward with
  `supabase migration up --local` instead. A lost payout can be
  rebuilt by the app's chain import on the next treasury sync, with
  `scripts/recover-payout-tx.mjs` as a manual fallback (below).
- The reconcile, GitHub-sync and calls-sync crons are Netlify schedules and
  never reach localhost. Run them by hand when you need confirmation locally: the
  "Scheduled jobs" section of `/dev` (a wallet in `DEV_WALLETS`) has a
  "Run now" button per job and shows the result, or from a shell:
  `curl -X POST -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/reconcile`.
  Reconciling a GitHub-sourced task still comments on the real issue, so
  prefer the native seed tasks.

## Migrations (the day-to-day commands)

Migrations live in `supabase/migrations/` and are numbered by hand
(`0001_core.sql`, `0002_…`, and so on). Keep that convention: create the next
file yourself rather than using `migration new`, which generates a timestamp
prefix.

| Command | What it does |
|---|---|
| `supabase db push` | Applies every migration not yet recorded on the remote. Runs each one as a transaction. This is the normal deploy step. |
| `supabase db push --dry-run` | Lists which migrations *would* be applied without running them. Use before a real push. |
| `supabase db push --include-all` | Also pushes migrations whose version is older than the latest applied one (needed if a file was added out of order). |
| `supabase migration list` | Side-by-side view of local files vs. versions recorded on the remote. First stop when a push refuses to run. |
| `supabase migration repair --status applied <version>` | Marks a version as applied on the remote without running it (e.g. the SQL was pasted in the dashboard). |
| `supabase migration repair --status reverted <version>` | Removes a version from the remote history so `db push` will run it again. |
| `supabase migration new <name>` | Creates a timestamped empty migration file. Avoid here — rename to the `NNNN_name.sql` convention if you use it. |

Typical flow for a schema change:

```powershell
# 1. write supabase/migrations/00NN_<name>.sql by hand
npm run db:migrate              # 2. applies only the pending file(s) to the running local DB
#    (npm run db:reset also proves it applies from scratch, but wipes any
#     local-only transaction history — see "Things to keep in mind" above)
npm run seed:sandbox            # 3. test in the app on npm run dev
# 4. run the SQL fixtures (next section; add one for the new rules)
supabase db push --dry-run      # 5. check only 00NN is pending
supabase db push                # 6. apply to the remote — the only remote write in the loop
supabase migration list         # 7. confirm remote history matches
```

## SQL fixtures

CI (`.github/workflows/ci.yml`) runs every `supabase/tests/*.sql` against a
`postgres:17` service on each PR. Locally the same fixtures need a throwaway
plain Postgres — they use psql meta-commands (`\ir`, `\set`), so
`supabase db query` cannot run them, and the local Supabase stack already has
the `anon`/`authenticated` roles the fixtures create. With Docker:

```powershell
docker run -d --rm --name treasury-guild-sql-tests -e POSTGRES_PASSWORD=test -p 54330:5432 postgres:17
# wait until ready:  docker exec treasury-guild-sql-tests pg_isready -h 127.0.0.1 -U postgres
$env:PGPASSWORD = 'test'
# one fixture (name filter by hand), or loop Get-ChildItem supabase/tests/*.sql for all:
psql postgresql://postgres@localhost:54330/postgres -X -q -v ON_ERROR_STOP=1 -f supabase/tests/signius_sandbox_seed.sql
docker rm -f treasury-guild-sql-tests
```

Each fixture builds the schema from the migrations, asserts, and rolls
everything back, so one container serves them all. The seed fixtures
(`-Filter signius` in the old runner's terms) are
`signius_sandbox_seed.sql`, `signius_live_seed.sql` and
`signius_seeds_head.sql`.

## Inspecting the remote schema

| Command | What it does |
|---|---|
| `supabase db diff --linked` | Diffs the linked remote against local migrations. Prints SQL for any drift (dashboard edits that never became a migration). |
| `supabase db diff --linked -f <name>` | Same, but writes the diff into a new migration file. Rename it to the numbered convention afterwards. |
| `supabase db pull` | Pulls the remote schema into a migration file. Only for bootstrapping; this repo already has a full migration history. |
| `supabase db dump --linked -f schema.sql` | Dumps the remote schema (no data) to a file. |
| `supabase db dump --linked --data-only -f data.sql` | Dumps remote data only. |
| `supabase db lint --linked` | Runs plpgsql_check style lints against remote functions (e.g. `add_signature`, `jwt_wallet`). |
| `supabase db query --linked "<sql>"` / `-f file.sql` | Runs SQL on the remote over the Management API (no DB password). Multi-statement files and `DO` blocks work; only the last result set comes back and `NOTICE` lines are dropped. |
| `supabase inspect db table-sizes --linked` | Table sizes on the remote. Other `inspect db` subcommands: `index-usage`, `long-running-queries`, `bloat`, `cache-hit`. |

## Generating TypeScript types

```powershell
supabase gen types typescript --linked > src/lib/supabase/database.types.ts
```

This is optional: the app hand-types its rows in `src/lib/db/types.ts` and
does not consume this generated file. Update the affected row types and
query helpers after schema changes; generate a file only for inspection or
as part of an intentional change to the typing approach.

## Local stack: raw CLI equivalents

`npm run db:*` wraps the first four of these (see the top of this file).
Useful on their own:

| Command | What it does |
|---|---|
| `supabase db reset --local` | Same as `npm run db:reset`. |
| `supabase db diff --local` | Diffs the local DB against migrations (drift from Studio edits). |
| `supabase db dump --local --data-only -f out.sql` | Dumps local data, e.g. to keep a hand-made scenario. |
| `supabase status -o env` | The raw values to copy into `.env` (mapping at the top). |
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
| `supabase secrets list` | Lists secrets stored on the remote project (for edge functions). |
| `supabase secrets set KEY=value` | Sets one. |
| `supabase functions list` | Lists deployed edge functions (expect none). |

## Troubleshooting

- **`npm.ps1 cannot be loaded because running scripts is disabled`** — use
  `npm.cmd` in place of `npm` in PowerShell.
- **"Access token not provided" / wrong project shown** — run `supabase login`
  (or set `SUPABASE_ACCESS_TOKEN` for the session) and confirm with
  `supabase projects list` that the Treasury Guild project is the linked one
  (`supabase link --project-ref <ref>` if not).
- **`db push` says remote is ahead / version mismatch** — run
  `supabase migration list`, then `migration repair` the offending version.
- **Link prompts for a password every time** — the CLI caches it in the OS
  keyring; pass `-p <password>` to `link` once if the keyring is unavailable.
- **`.temp/` missing after clone** — expected. Re-run `supabase link`.
- **Need the JWT secret / API keys** — local: `supabase status -o env`.
  Remote: Project Settings → API in the dashboard; see the Supabase section
  of the root README.
- **`npm run db:snapshot` asks for a password / fails to connect** — it dumps
  the **linked** project; run `supabase link` first. Set `SUPABASE_DB_URL` in
  `.env.remote` only if you also want a direct `pg_dump`/`psql` connection
  string by hand (Project Settings → Database; use the session pooler string
  if direct IPv6 is not reachable).
- **`npm run seed:sandbox` says it cannot reach the local database** — Docker
  Desktop is not running or the stack is stopped: `npm run db:start`.
- **App shows "not configured" errors after editing `.env`** — restart `npm run
  dev`; Next reads `.env` at startup only.
