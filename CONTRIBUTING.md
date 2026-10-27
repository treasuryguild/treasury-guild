# Contributing to Treasury Guild

Thanks for helping out. This guide covers the contribution workflow;
development conventions and hard invariants live in `CLAUDE.md`, and the
product overview is `docs/OVERVIEW.md` — read both before changing code.

## Workflow

1. **Never commit directly to `main`.** Work on a branch and open a pull
   request into `main`; CI only runs on pull requests, so a direct push
   bypasses every check. If you don't have write access, fork the repo and
   open the PR from your fork.
2. Start from an up-to-date, clean tree:

   ```powershell
   git switch main
   git pull
   git switch -c fix/short-description
   ```

   Branch prefixes such as `feat/`, `fix/`, `docs/`, `chore/` are a
   convention, not an enforced rule. Keep each branch and PR focused on one
   change — don't mix unrelated work.

3. Make your change, following the layout rules in `CLAUDE.md` (one home
   per concept; pure logic in `src/lib` with a `*.test.ts` beside it; API
   handlers tested beside the route).
4. Run the checks locally (same as CI, see below) and push your branch.
5. Open the PR against `main`. There's no PR template, so describe: what
   changed, why, how you tested it, screenshots for UI changes, and a note
   if the PR includes a migration or doc update. Request a review manually
   (no reviewers are auto-assigned). Don't merge with failing CI.

## Setup

Requires Node.js 22+, npm, Docker Desktop, the Supabase CLI and `psql`
(PostgreSQL 17 client). Full details are in `README.md` § Setup and
`scripts/README.md`; the short version:

```powershell
Copy-Item .env.example .env   # first setup only
npm ci
npm run db:start              # local Supabase stack in Docker
npm run db:migrate            # apply pending migrations (keeps local data)
# copy values from `supabase status -o env` into .env (mapping in scripts/README.md)
npm run dev                   # http://localhost:3000 against the local stack
```

Day-to-day development runs against the **local** stack. Local database
commands never write to the remote; `supabase db push` deploys schema
changes — check the link target before running it. Never commit `.env`
files, secrets, or the gitignored `supabase/seeds/local/` snapshot.

## Before opening a PR

CI (`.github/workflows/ci.yml`) runs on every PR into `main` with no
secrets and never touches the Supabase project. Run the same checks first:

```powershell
npx next typegen      # needed on a fresh clone; generates types tsc includes
npm run typecheck
npm run lint
npm test
```

`npm run build` is a worthwhile extra local sanity check.

### Changes that need extra pieces in the same PR

- **User flow or page changes** → update the matching guide in
  `src/content/docs/*.mdx`. A new page needs its `routes` entry in
  `src/lib/routes.ts` and a `DOC_PATHS` entry in `src/lib/docs.ts`. Check
  with `npm test -- src/lib/docs.test.ts`. Renaming a doc heading means
  updating anchors and cross-links.
- **Database schema changes** → add a new migration in
  `supabase/migrations/` (never edit a shipped one) and a self-contained
  fixture in `supabase/tests/*.sql`. CI runs every fixture against a
  throwaway `postgres:17`; local commands are in `scripts/README.md`.
  Use only the bare Supabase CLI — there are no helper scripts.
- **Environment variables** → document them in `.env.example`; every
  non-`NEXT_PUBLIC_*` variable is read in `src/lib/env.server.ts` only.
- **Setup changes** → update `README.md` and `scripts/README.md`.
- **New agent-API tools or fields** → update
  `src/content/docs/ai-assistants.mdx` (and the privacy policy if what is
  stored about a person changes). The same applies to any change to what
  is stored about a person: update `src/content/docs/privacy.mdx`.

## Notes

- This Next.js version has breaking changes versus older releases; check
  `node_modules/next/dist/docs/` before using unfamiliar APIs (see
  `AGENTS.md`).
- If you're unsure where a change belongs, ask in an issue or draft PR
  before writing lots of code.
