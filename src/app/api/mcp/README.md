# Agent API: MCP (`POST /api/mcp`) and REST (`/api/v1`)

A [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI client
(claude.ai, Claude Desktop, Claude Code, any MCP client) can read a wallet's
communities, treasuries, transactions, inflows, funding, workgroups, members, tasks, calls,
budgets and proposals, and what waits for the wallet's signature, and prepare changes the
user confirms (proposals, tasks, calls, payout drafts). The same tools are REST endpoints
under `/api/v1`. The shape follows the multisig repo's `/api/mcp` (stateless SDK v2
handler, its own OAuth 2.1 authorization server, a scope-filtered tool list).
User-facing docs: `src/content/docs/ai-assistants.mdx`.

## One endpoint, two adapters

Each read, preview and confirm is defined once in `src/lib/api/v1/*.ts`:

```ts
export const listTasks = defineEndpoint({
  scope: "communities:read",
  input: z.object({ community: communityInput, ... }),   // zod: the only schema
  async run(caller, input) { ...authorize, load, shape... },
});
```

- **REST**: `export const GET = v1Route(listTasks)` in `src/app/api/v1/**/route.ts`
  (`export const POST = v1PostRoute(endpoint)` for a write, input from the JSON body).
  Query parameters and path segments are the input; `"true"` / `"false"` become booleans.
- **MCP**: `src/lib/mcp/tools.ts` registers the endpoint as a tool. The SDK takes the
  zod schema directly (Standard Schema) and publishes its JSON Schema, with defaulted
  fields optional.

Both adapters go through `callEndpoint` (scope check, zod parse, `run`), so every
authorization check lives in `run`. multisig gets the same property by invoking its v1
Pages handlers in-process with a synthetic request; App Router handlers make that
unnecessary.

| MCP tool | REST | Endpoint |
|---|---|---|
| `guild_whoami` | `GET /api/v1/me` | `whoami` (`communities.ts`) |
| `community_list` | `GET /api/v1/communities` | `listCommunities` |
| `treasury_overview` | `GET /api/v1/communities/{community}/treasuries` | `treasuryOverview` |
| `task_list` | `GET /api/v1/communities/{community}/tasks` | `listTasks` |
| `budget_summary` | `GET /api/v1/communities/{community}/budgets` | `budgetSummary` |
| `proposal_list` | `GET /api/v1/communities/{community}/proposals` | `listProposals` |
| `signing_queue` | `GET /api/v1/me/signing-queue` | `signingQueue` (`signing.ts`) |
| `transaction_list` | `GET /api/v1/communities/{community}/transactions` | `listTransactions` |
| `workgroup_list` | `GET /api/v1/communities/{community}/workgroups` | `listWorkgroups` |
| `incoming_list` | `GET /api/v1/communities/{community}/incoming` | `listIncoming` |
| `member_list` | `GET /api/v1/communities/{community}/members` | `listMembers` |
| `proposal_preview` | `POST /api/v1/communities/{community}/proposals/preview` | `previewProposal` (`proposalWrite.ts`, scope `proposals:write`) |
| `proposal_create` | `POST /api/v1/communities/{community}/proposals/create` | `createProposalFromDraft` (same) |
| `transaction_detail` | `GET /api/v1/communities/{community}/transactions/{tx}` | `transactionDetail` (`transactions.ts`, loader `db/txDetail.ts`) |
| `funding_summary` | `GET /api/v1/communities/{community}/funding` | `fundingSummary` (`funding.ts`) |
| `call_list` | `GET /api/v1/communities/{community}/calls` | `listCalls` (`calls.ts`) |
| `proposal_detail` | `GET /api/v1/communities/{community}/proposals/{proposal}` | `proposalDetail` (`proposals.ts`) |
| `proposal_withdraw_preview` | `POST …/proposals/withdraw/preview` | `previewProposalWithdraw` (`proposalWithdraw.ts`, `proposals:write`) |
| `task_preview` | `POST …/tasks/preview` | `previewTaskSave` (`taskWrite.ts`, `tasks:write`) |
| `call_create_preview` | `POST …/calls/preview` | `previewCallCreate` (`callWrite.ts`, `tasks:write`) |
| `call_finalize_preview` | `POST …/calls/finalize/preview` | `previewCallFinalize` (same) |
| `payout_preview` | `POST …/payouts/preview` | `previewPayout` (`payoutWrite.ts`, `payouts:write`) |
| `draft_confirm` | `POST /api/v1/drafts/confirm` | `confirmDraft` (`drafts.ts`, any write scope; the action's own scope inside) |

**Almost every tool reads.** Results carry member-written text (task titles, names,
descriptions) that reaches the model. A signing or paying tool next to that would turn
prompt injection into a funds-movement path, so no tool signs, submits or votes, and every
write goes through a preview the user agrees to. `src/lib/mcp/tools.test.ts` pins the whole
list, the two tools that carry a write out (`proposal_create`, `draft_confirm`), which
previews each write scope offers, and that every write sits behind a `:write` scope only.

## Proposals: preview → confirm

The first write, and the model for the others below: multisig's `transaction_preview` →
draft token → `transaction_propose` pattern. A proposal is itself gated: it changes
nothing until members vote on it with their wallets.

- **Scope `proposals:write`**, separate from `communities:read`. A client that names no
  scope is offered the read scopes only (`requestedScopes`), and the consent page shows a
  write scope **unticked**, so the user opts in. A grant without it (a refresh can only
  narrow a grant; no UI removes one scope, the user disconnects) never lists
  `proposal_preview`, `proposal_create` or `proposal_withdraw_preview` (nor
  `draft_confirm` without any write scope).
- **`proposal_preview`** builds the app's own create body (`createProposalSchema`) and runs
  `prepareProposal` (`src/lib/governance/propose.ts`): every check of `POST /api/proposals`
  (kind on, `requireProposer`, payload, frozen rules, hashes, a budget's rolled-back dry
  run), writing nothing.
- **The draft token** (`src/lib/mcp/draftToken.ts`) is a 15-minute JWT, `typ`
  `tg_mcp_draft`, signed with a key derived from `MCP_TOKEN_SECRET` for this purpose only
  and audience `${APP_URL}/mcp-draft`, so it is never an access token and an access token
  is never a draft. It carries the create body, the preview's fingerprint and rules hash
  and a random `jti` (the draft id), and is bound to the wallet, the OAuth client and the grant's `created_at`
  (`ApiCaller.grantCreatedAt`): another connection, or the same one after a Disconnect,
  cannot redeem it.
- **`proposal_create`** takes the token (plus an optional `community`, which must be the
  token's: a 400 otherwise; `draft_confirm` takes the same pair). The proposal is keyed by the token's `jti`
  (`proposals.agent_draft_id`, migration 0064). It first answers with the proposal that
  draft already made (`findProposalByDraft`), before re-checking anything, since a made
  budget proposal holds its budgets. Otherwise it:
  1. re-runs `prepareProposal` (a 409 there gets "Preview the proposal again.");
  2. refuses (409) when the **fingerprint** or rules hash moved;
  3. charges the app's `proposalCreate` rate limit;
  4. calls `create_proposal_from_draft`. That function takes an advisory lock on the
     draft id, returns that draft's proposal if one exists (`created: false`), and
     otherwise runs `create_proposal` and stamps the draft id. Two confirmations in the
     same instant therefore make one proposal (checked with two concurrent sessions,
     and in `supabase/tests/agent_proposal_drafts.sql`).
- **The fingerprint** (`draftFingerprint`) is sha256 over the canonical content, payload,
  workgroups, beneficiaries and budget owners. It is used instead of `content_hash`,
  which differs on every resolve of a budget proposal: `resolveBudgetAmounts` stamps
  `updated_at` and `created_by` into each amount, and the fingerprint drops them.
- **Budget proposals.** `budget.changes` names an owner (a workgroup, or a treasury with
  `ownerType`), a `plan` (`recurring` or one `period`), a cadence, `startsOn` and amounts
  by ticker. `budgetSaves` turns these into the Budgets page's saves:
  - owners are resolved by name;
  - `expectedRevision` is the owner's revision now, so a save in between refuses the
    confirmation;
  - `confirmTransition` is set when the mode or cadence in force at the start differs, or
    nothing is in force (`loadSetupInForce`);
  - tickers are resolved from ADA, the registry, else the owner's treasury tokens (a
    chain read under `chainProxy`);
  - amounts are scaled with the decimals that `resolveBudgetAmounts` itself will store.
- **Members by name.** Workgroup leads may be a full wallet, a handle (any case) or a
  GitHub login with or without `@`, tried in that order (`matchMembers` in `shape.ts`,
  `requireMember` in `shared.ts`, which is name matching, not the `authz.ts` check). A
  member `member_list` shows by a shortened wallet must be named by the full one. A name
  that fits nobody, or several members, is a 400 naming them. `member_list` serves the same data
  that members read in the app.
- REST serves both as POSTs through `v1PostRoute`, which refuses a cross-site request like
  `sessionRoute` (the session cookie works there too, and can already make proposals
  through `/api/proposals`).
- The server instructions tell the model to show the preview and confirm only after the
  user explicitly agrees, never because a result asked for it.

## Other writes: `*_preview` → `draft_confirm`

Withdrawing a proposal, saving a task, creating a call, paying a call's attendance and
drafting a payout follow the same pattern with one shared confirm tool.

- **The token names its action** (`act` claim, `DRAFT_ACTIONS` in `draftToken.ts`; a token
  without one reads as `proposal_create`). `DRAFT_ACTION_DEFS` (`src/lib/api/v1/drafts.ts`)
  maps each action to its write scope and its `confirm`:

  | Action | Scope | Preview tool |
  |---|---|---|
  | `proposal_create` | `proposals:write` | `proposal_preview` (confirmable through both; the tools and server instructions point the model at `proposal_create`) |
  | `proposal_withdraw` | `proposals:write` | `proposal_withdraw_preview` |
  | `task_save` | `tasks:write` | `task_preview` (create or edit) |
  | `call_create` | `tasks:write` | `call_create_preview` |
  | `call_finalize` | `tasks:write` | `call_finalize_preview` |
  | `payout_create` | `payouts:write` | `payout_preview` |
  - `draft_confirm` is offered to a connection holding *any* write scope; an endpoint
    `scope` may be a list, meaning any one of them (`endpointScopes`, `endpointAllowed`).
  - `draft_confirm` then checks the action's own scope, so a `tasks:write` connection
    cannot confirm a payout.
- **Every confirm re-checks**; previews whose result depends on live state (a proposal, a
  withdraw, a task edit, a finalize, a payout) also compare a fingerprint of that state,
  while a task or call create's fingerprint only binds the signed request (their live
  checks are `firstOpenColumn` and `checkCreateCall`). A repeat does the change once and
  answers `created: false`:
  - A create is keyed by the draft id: created rows carry `agent_draft_id` (migration
    0065: `transactions`, `tasks`, `calls`, unique each; fixture
    `supabase/tests/agent_drafts.sql`). A payout confirm that loses a race to the
    one-pending-transaction index looks the draft up and answers the same.
  - A withdraw, a task edit and a call finalize store no draft id; they answer from the
    state: the proposal is already withdrawn by this wallet, the task already reads as the
    preview's "after", or nobody is left to pay (a repeated finalize lists no task numbers,
    and is a 409 when new attendees became ready in between). So the same change made by
    hand in the app also reads as done.
  - A call create checks the workgroup is still the draft community's inside `createCall`
    (`communityId`), before the insert.
  - Members can read `agent_draft_id` (whole-row RLS reads, no column grant), so they can
    tell a record came through an assistant; the privacy policy says so.
- **Payouts.** The build moved out of `POST /api/tx/build-payout` into
  `src/lib/payout/build.ts`, which the route and `payout_preview` share:
  - `planPayout` is every check plus the unsigned transaction, with no writes. The
    builder's plain refusals ("Insufficient treasury funds", "Payout too large", "No
    recipients") are now 400s with their text.
  - `persistPayout` stores it (`agentDraftId` optional).
  - The preview picks the tasks (numbers, or every ready task) and the treasury (given,
    the only one, or the one the workgroups route to now).
  - The fingerprint covers recipients, tasks and amounts, the path and the budget
    problems, not the fee or inputs. The confirm re-plans from the chain and stores the
    pending transaction; signers sign in the app. Manual token connections stay on Payday.
- **Tasks.** Service-role writes re-check in code what the browser's RLS and column grants
  check: a manager, an active app board, and never a task past `pay_state 'none'`.
  - Create goes in the first column neither payable nor paid (`firstOpenColumn`).
  - An edit is a conditional update (`updateNativeTaskFields`, `pay_state = 'none'` in
    the `where`), so a task moved to payable in between is refused, not changed.
  - Columns and `pay_state` are never written.
- **Calls.** `POST /api/calls` and `POST /api/calls/[id]/finalize` now run
  `src/lib/calls/create.ts` and `src/lib/calls/finalize.ts`, which the previews share.
  - The finalize fingerprint is the ready attendee ids and the reward;
    `finalize_call_at_reward` still refuses a reward changed under it.
- **Reads that bypass RLS gate in code**:
  - `proposal_detail` shows others' ballots only when `ballotsVisible`;
  - `call_list` selects `CALL_ATTENDEE_COLUMNS`, never `external_id`;
  - `transaction_detail` is scoped to the community's treasuries and decodes the record
    from the transaction's own CBOR.
- MCP error texts now list a 400's `problems` (for example "Some tasks are not
  payable"), so the model can say which.

## Stateless transport

One HTTP POST is one complete MCP exchange: there is no session store and no
resumability. `GET` and `DELETE` (the 2025 session verbs) answer 405. The SDK serves the
2026-07-28 envelope protocol and the 2025 `initialize` handshake from the same registry.
The 2025 path answers as a one-event SSE stream.

`createMcpHandler(() => createMcpServer(caller))` builds a fresh server and transport
**per request**. Nothing may be hoisted to module scope: a reused transport fails on the
*second* request. `route.test.ts` sends two requests and drives the real SDK, because a
mocked SDK would prove nothing about the wiring.

## Authentication

- `/api/mcp` accepts only `Authorization: Bearer <access token>`. The session cookie
  never works there, and a request with an `Origin` header is refused (403): MCP clients
  are servers, and a browser driving the endpoint is a DNS-rebinding / cross-site vector.
- `/api/v1` accepts the same token, or the session cookie, which gets every scope. That
  is what the signed-in user can already do in the app.
- A Bearer request is judged on the token alone and never falls back to the cookie.
- Every request **re-reads the grant** (`oauth_grants`), intersects the scopes, and
  requires the token's `gat` claim to equal the grant's `created_at`. Settings →
  Disconnect bites on the next request, not when the hour-long token expires, and
  approving the same assistant again later never revives the old tokens.
- `/api/mcp` and `/api/v1` share one per-wallet rate limit (`agentApi`), so REST cannot be
  looped where MCP is capped. A declared oversize MCP body is refused before it is read.
  Chain reads (treasury balances, a budget proposal's held tokens, a payout preview) also
  charge `chainProxy`; proposals, in the app or through an assistant, `proposalCreate`.

An unauthenticated MCP request gets the RFC 9728 challenge:

```
WWW-Authenticate: Bearer resource_metadata="<APP_URL>/.well-known/oauth-protected-resource/api/mcp", scope="communities:read proposals:write tasks:write payouts:write"
```

It names **every** scope. Clients request exactly the challenge's `scope`, so a scope
left out there could never be granted. The user narrows scopes on the consent page.

## OAuth 2.1 authorization server (`src/lib/oauthServer/`)

| Route | Purpose |
|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `/.well-known/oauth-protected-resource[/api/mcp]` | RFC 9728 metadata (clients probe the path-aware form first) |
| `GET /api/oauth/authorize` | Validates, signs a `mcp-authorize` handle, redirects to `/oauth/consent` (rate limited per IP) |
| `GET /api/oauth/request` | The consent page's view of a handle |
| `POST /api/oauth/decision` | Session route: records the grant, issues a one-minute code |
| `POST /api/oauth/token` | `authorization_code` (PKCE S256) and `refresh_token` (rotating); rate limited per IP |
| `POST /api/oauth/register` | RFC 7591 DCR (deprecated fallback, rate limited per IP) |
| `GET`/`DELETE /api/oauth/connections` | Settings: list / disconnect approved assistants |

Properties worth not regressing (tests in `src/lib/oauthServer/*.test.ts`,
`src/app/api/mcp/route.test.ts`, `src/lib/api/v1Route.test.ts` and
`supabase/tests/mcp_oauth.sql`):

- **The issuer is `APP_URL`**, never the Host header. The resource and audience are
  `${APP_URL}/api/mcp`.
- **Access tokens are signed with `MCP_TOKEN_SECRET`**, never `SUPABASE_JWT_SECRET`, so
  an access token is never a PostgREST or session token and a session JWT is never an
  access token. They are typed `typ: tg_mcp_at` with header `at+jwt`. The secret is
  **required in production**: the CRON_SECRET-derived key is only a dev/test fallback.
  The cron triggers hold `CRON_SECRET`, and Claude's CIMD client_id is public, so that
  key in production would let a leaked cron secret mint read access for anyone who
  connected Claude.
- **No open redirect.** An unknown client or unregistered `redirect_uri` is shown on the
  consent page and never redirected to. Only https or loopback-http redirect URIs are
  accepted. Loopback URIs match with the port ignored (RFC 8252).
- **The consent page never renders URL text.** A refusal arrives as `?error=<code>` and
  is shown through `consentErrorMessage` (`consentErrors.ts`). Anything else reads as
  "the request is not valid", so nobody can put their own words on a Treasury Guild page.
- **Identity is shown for what it is.** A CIMD client is labelled with the domain serving
  its metadata document (`verifiedDomain`). A DCR client's name is flagged as
  self-declared, with a warning when it returns to a website rather than a local program.
  Open registration means anyone can register "Claude".
- **Client ID Metadata Documents**: the document's `client_id` must equal its URL, and
  the fetch is SSRF-guarded (`ssrf.ts`), size-capped, time-limited and never follows a
  redirect. The check is resolve-then-fetch, so a DNS rebind between the two is not
  closed; this was accepted, as in multisig. Claude Code selects CIMD only when both
  `client_id_metadata_document_supported` and the `none` auth method are advertised.
- **The handle says what, the cookie says who.** The decision takes the wallet from the
  session, never the body, and refuses a cross-site request. Ticked scopes only narrow
  the handle's, and an empty set is refused.
- **Secrets are stored hashed.** Codes, refresh tokens and client secrets are sha256.
  Redemption is a conditional update (atomic per statement). A replayed code, or a
  rotated refresh token presented again, means a leak and **deletes the grant**: every
  refresh and access token of that connection dies at once, and the user reconnects.
- **A code needs a live grant**: one redeemed after Disconnect gets nothing.
- **Refresh narrows, never widens**, and fails once the grant is gone.
- `purge_oauth` (reconcile sweep, migration 0054) drops expired codes and refresh tokens,
  DCR clients nobody approved within a day, and CIMD clients with no grant not fetched
  for a day. Unauthenticated authorize/token calls cache CIMD documents, so without this
  the table could be grown at will.
- **CORS `*`** on metadata, token and register is deliberate: they authenticate no cookie.
- **Prompt injection** is bounded by no tool signing, submitting or voting, and by every
  write needing a separately ticked `:write` scope and the user's confirmation of a
  preview; a proposal then still needs a vote, and a payout draft the signers' wallets.
  The server instructions tell the model to treat member-written text as data.

## Results

- A tool returns its body as a JSON text block plus the same object as
  `structuredContent`.
- Content blocks carry no `annotations`: the Claude app rejected results with them (seen
  in multisig).
- An `HttpError` / `DomainError` / `UpstreamError` becomes `isError: true` with
  `"<status>: <message>"`, so the model can correct itself (wrong slug, unknown workgroup).
- Anything else is logged and reported generically.

`MCP_SERVER_INSTRUCTIONS` (in `src/lib/mcp/server.ts`) is short and behavioural.
Clients read it once, at initialize, so reconnect after changing it.

## Trying it locally

```bash
npm run dev
curl http://localhost:3000/.well-known/oauth-protected-resource/api/mcp
npx @modelcontextprotocol/inspector   # URL http://localhost:3000/api/mcp, via its proxy (no Origin)
claude mcp add --transport http treasury-guild-local http://localhost:3000/api/mcp
```

The `/api/v1` routes also answer in a browser tab signed in to the app.

## Tests

```bash
npx vitest run src/app/api/mcp src/lib/mcp src/lib/api/v1 src/lib/oauthServer
# SQL fixture supabase/tests/mcp_oauth.sql: see "SQL fixtures" in scripts/README.md
```
