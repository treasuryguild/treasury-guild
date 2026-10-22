<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Treasury Guild

- Code layout rules and hard invariants: `CLAUDE.md`. Read it before changing code.
- What the product is: `docs/OVERVIEW.md`. Design and fix plans:
  `docs/onchain-anchoring-estimate.md`, `docs/test-findings-fix-plan.md`.
- Database (Supabase CLI only, no helper scripts) and seeds: `scripts/README.md`, `supabase/seeds/README.md`.
- Agent API (MCP, `/api/v1`, OAuth server): `src/app/api/mcp/README.md`.
