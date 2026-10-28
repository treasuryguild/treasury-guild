# Treasury Guild — development notes

Cardano community treasury manager. Next.js App Router + MeshJS + Koios +
Supabase (RLS, no ORM) + Netlify.

## Commands

- `npm run dev` / `npm run build`
- `npm test` — vitest unit tests
- `npm run typecheck` / `npm run lint`
- **Local-first database**: `npm run db:start` / `db:stop` / `db:status` /
  `db:migrate` (pending migrations only) / `db:reset` (migrate from scratch +
  load snapshot) / `db:snapshot` (copy remote data to the gitignored
  `supabase/seeds/local/`) are thin aliases over the Supabase CLI
  (`supabase start` / `stop` / `status` / `migration up --local` /
  `db reset --local` / `db dump --linked`); there are no helper scripts —
  everything database-related goes through the bare `supabase` CLI
  (`supabase login` + `supabase link` once per machine). Point `.env` at the local stack by copying `supabase status
  -o env` values by hand (mapping in `scripts/README.md`); remote values
  live in `.env.remote`, loaded manually when running the app against the
  remote. Local DB commands never write to the remote; `supabase db push`
  deploys schema changes, while running the app or seeds against the remote
  also writes data. See `scripts/README.md`.
- `npm run seed:sandbox` (wipe + reseed build-only Signius test tasks) /
  `npm run seed:live` (append one real payout batch to each of the two live
  workgroups: monthly on the mint treasury, quarterly on a second treasury)
  target the **local** stack via `psql`; seeding the remote is a manual
  `supabase db query --linked -f …` (no npm alias, no confirmation prompt —
  check the link target first). The three Signius seed fixtures (sandbox,
  live, head schema) run in a throwaway Docker Postgres with `psql`
  (commands in `scripts/README.md`; CI runs every `supabase/tests/*.sql`
  the same way). See `supabase/seeds/README.md`.
- **CI** (`.github/workflows/ci.yml`, PRs into `main`): typecheck / lint /
  vitest (after `npx next typegen`) plus every `supabase/tests/*.sql` against
  a `postgres:17` service. No
  secrets, never touches the Supabase project; a new SQL fixture must pass there.

## Code layout rules

- **One home per concept.** Row shapes live in `src/lib/db/types.ts`
  (client-safe); service-role query helpers in `src/lib/db/*.ts`
  (`server-only`, unwrap results with `must`/`maybe`/`rows`/`check`, `allRows`
  for a paginated full read), so no route calls `serviceClient()` itself (a
  few older lib modules still query directly: `authz.ts`, `tx.ts`,
  `github/sync.ts`, `discord/notify*.ts`, `reconciliation/*`,
  `cosigner/sign.ts`); enum-like
  constants (`TxState`, `PayState`, `Role`, `PgCode`, …) in `src/lib/constants.ts`; app
  paths only via `src/lib/routes.ts`. RPC errors map to HttpErrors through
  `rpc` / `throwRpcError` in `src/lib/db/client.ts` (with `relation` /
  `optionalRelation` for to-one embeds), never a per-route code ladder.
  Shared client-safe helpers: type guards in `src/lib/guards.ts` (`isRecord`,
  `isUuid`, `isStringArray`), CSV parsing in `src/lib/csv.ts`, file downloads
  in `src/lib/browser/download.ts`. Cron job ids are registered in
  `src/lib/cron/jobs.ts`, `/dev` tools in `src/components/dev/tools.tsx`.
- **Authorization helpers** live in `src/lib/authz.ts` (`requireMember`,
  `requireAdmin`, `requireWorkgroupManager`, `requireWorkgroupAdmin`,
  `requireTreasuryAdmin`, `requireTreasuryActor` / `isTreasuryActor`,
  `requireProposer`, `leadsAllWorkgroups`; `src/lib/calls/access.ts` wraps `requireWorkgroupManager`
  under the same name with the calls wording); `requireWorkgroupCommunity` / `requireCommunity` 404 in
  `src/lib/db/*`. The browser mirrors of the rules are `managesWorkgroup` /
  `actsForTreasury` / `mayRecover` / `mayPropose` in `src/lib/roles.ts`.
- **OAuth**: every callback starts with `readOAuthCallback` (`readOAuthReturn`
  for the code-less GitHub install return) + `oauthRedirect`
  (`src/lib/oauth/callback.ts`); return paths go through `safeReturnTo`
  (`src/lib/api/schemas.ts`).
  Personal account links (Discord, Google) are the `identityConnectRoute` /
  `identityCallbackRoute` / `identityDisconnectRoute` factories
  (`src/lib/oauth/identityLink.ts`) over `identityProviders.ts`. Community host connections (Discord server, Zoom, Google host) are the
  `hostConnectRoute` / `hostCallbackRoute` / `hostDisconnectRoute` factories
  (`src/lib/oauth/hostLink.ts`) over one adapter each in `hostProviders.ts`;
  token requests and refresh-before-use go through `src/lib/oauth/token.ts`.
  The GitHub account link (`/api/github/oauth-callback`) uses neither: it is
  a hand-written `publicRoute` with its own token request (GitHub takes the
  code grant as JSON).
- **Env**: every non-`NEXT_PUBLIC_*` variable is read in `src/lib/env.server.ts`
  and nowhere else under `src/` (the Netlify cron triggers and
  `scripts/recover-payout-tx.mjs` read their own). `src/lib/config.ts` is
  client-safe.
- **API routes** are `sessionRoute` / `publicRoute` / `cronRoute` / `devRoute`
  (`/api/dev/*`, `DEV_WALLETS` only) handlers from `src/lib/api/route.ts`,
  which (except `cronRoute`) reject a state-changing request declaring another
  origin (`isCrossSite`, `Sec-Fetch-Site` / `Origin`; GET / HEAD / OPTIONS
  pass): parse with zod (`src/lib/api/schemas.ts`), throw
  `HttpError` subclasses from `src/lib/errors.ts`, return plain objects typed
  by `src/lib/api/types.ts`. Three more wrappers serve the agent API (see
  its invariant): `v1Route(endpoint)` for `/api/v1/*` GETs,
  `v1PostRoute(endpoint)` for its POST previews and confirms (cross-site
  refused like `sessionRoute`), and
  `oauthRoute` for the authorization server's metadata (including the
  protected-resource metadata under `/.well-known`) / token / register
  endpoints (no session, no cross-site check, CORS `*`, errors as
  `OAuthProtocolError` → `{ error, error_description }`; each such file also
  exports `OPTIONS = oauthPreflight`). Two handlers are written by hand:
  `POST /api/mcp` (its own Origin refusal, caller, rate limit and JSON-RPC
  errors; the file answers GET and DELETE with 405) and
  `GET /api/oauth/authorize` (it answers with redirects).
- **Client data**: no raw `fetch` in components — `apiFetch` from
  `src/lib/api/client.ts`; fetch-in-effect goes through `useAsyncData`, busy/
  error state through `useAsyncAction`; page access gates through
  `useCommunityGate` / `useSessionGate` / `useDevGate`. Hooks live in
  `src/hooks/`; the gate decisions themselves are pure, in `src/lib/gate.ts`
  (and `src/lib/networkGate.ts`, behind `useNetworkGate`: a wallet on one
  network cannot act on the other).
- **Formatting is exact**: `src/lib/format.ts` (`formatUnits`, `formatLovelace`)
  never does float math on on-chain integers (`formatQuantity`, the
  plain decimal string and inverse of `scaleDecimal`, is in `src/lib/assets.ts`).
- **Components** are PascalCase under `src/components/<area>/`; shared
  primitives come from `src/components/ui`.
- Pure logic lives in `src/lib` next to a `*.test.ts`; pages compose hooks and
  components and stay small. API route handlers are tested beside the route
  (`src/app/api/**/route.test.ts`, the `@/lib/*` modules they call mocked with
  `vi.mock`).
- **User docs** (`/docs`) are `src/content/docs/*.mdx`, registered in
  `src/lib/docs.ts` (`DOCS` order/titles, `DOC_PATHS` page → doc mapping).
  A change to what a page shows or how a flow works updates its doc in the
  same change; a new route needs a `DOC_PATHS` entry (the test walks `routes`
  in `src/lib/routes.ts`, not the page files, so a new page needs its `routes`
  entry to be checked at all). H2/H3 text is the
  anchor (`slugifyHeading`), so renaming a heading means updating `hash`
  values and cross-links — `src/lib/docs.test.ts` enforces all of this.
  MDX files have no `import` lines (shared components such as `Callout`
  come from `src/mdx-components.tsx`) and no H1. `docs/OVERVIEW.md` stays
  the agent-facing product overview, not user docs; `docs/*.md` beside it
  are design and fix plans (`onchain-anchoring-estimate.md`,
  `test-findings-fix-plan.md`).

## Hard invariants

- **Network is per community**, chosen at creation (`communities.network`,
  0 = preprod, 1 = mainnet) and never changed; every treasury must match
  (trigger in migration 0026). Chain code takes the network from the
  treasury/community row (`asNetwork`), or from the address prefix
  (`addressToNetwork`) for address-keyed chain proxies — never from
  `appNetwork()`, which is only the new-community form default (and a
  pre-load placeholder / health-check value; no chain code reads it).
- **core-cst only for tx bytes**: transactions are built, hashed and
  witness-merged with `@meshsdk/core-cst` (`resolveTxHash`,
  `addVKeyWitnessSetToTransaction`). `@meshsdk/core-csl` is read-only analysis
  — it re-encodes tx bodies to different bytes and breaks witness
  verification. A witness is verified against the core-cst hash (the
  signature check itself is core-csl's `PublicKey.verify`, which touches no
  tx bytes). See `src/lib/cardano/txSignUtils.ts`. Runtime core-csl values
  come only from `src/lib/cardano/csl.ts` (CommonJS `require`: the ESM entry
  breaks on Netlify); elsewhere `import type` only (enforced by
  `no-restricted-imports` in `eslint.config.mjs`; tests are exempt).
- **Metadata reads come from CBOR** (`src/lib/cardano/cborMetadata.ts`), never
  from stored builder JSON (MeshTxBuilder keeps metadata in a Map that
  stringifies to `{}`). One exception: the treasury activity list describes a
  not-yet-imported outside transaction from the Koios JSON the poller stored
  in `external_txs.payout_meta` (`src/lib/externalTx.ts`). The key legends shown beside raw metadata on the
  transaction page live in `src/lib/cardano/metadataLegend.ts`; a new or
  renamed key updates the legend, its test and the matching doc together.
- **Payout metadata (label 190001) is v3**, built only in
  `src/lib/cardano/metadata.ts` and positional: top-level `v` (3), `src`
  (`"treasury-guild"`), `c` (community slug), `w` (workgroup
  names), `b` (budget periods: "YYYY-MM" for a monthly workgroup, "YYYY-Qn"
  for a quarterly one, resolved by `taskBudgetPeriod` from the workgroup's
  setup timeline) and `k` (asset tickers, "ADA"
  included when paid as a bounty) lists; `p` = `[[outputIndex, [[taskNumber, wIdx, bIdx,
  [amount…]], …]], …]` where amounts align to `k` as exact decimal strings in
  display units (`formatQuantity`, decimals from the token registry), `""` =
  none of that asset, trailing `""` trimmed (metadata has no null). Bounty
  amounts only (never the min-UTxO bump), no handles, no addresses, no
  network flag. A task paid to N wallets appears under N output entries with
  identical amounts. `tasks.number` is assigned per community by a
  DB trigger and is permanent; `tasks.budget_month` drives budget
  attribution, stored as a day-1 date with a quarter as its first month
  (build-payout stamps the current period when unset, quarter-aligned for
  quarterly workgroups);
  `tasks.paid_tx_hash` is written by the `confirm_transaction` RPC (the poller) and by `import_chain_tx`:
  through `pay_tasks_for_tx` (migration 0062) for a confirmed or settled
  task, while a task the import creates is inserted already paid.
  Optional top-level `g` (**spend citations**, migration 0059, still v3):
  `[[proposalNumber, contentHash, [taskNumber…]], …]`, one entry per cited
  proposal, sorted by number, omitted when nothing is cited; the strict
  parser validates and carries it and the task entry keeps four elements.
  A task cites `tasks.proposal_id` (set only by `apply_task_proposal`, no
  browser column grant) and the proposal on the budget in force for its
  period (`budgetInForce` in `src/lib/budgetSetups.ts`: the plan row's
  `proposal_id`, else the setup's; both stamped by the
  `stamp_budget_proposal` trigger from `treasury_guild.proposal_apply` when it
  is uuid-shaped, null otherwise, so a direct save clears it). Citations are
  resolved in the build routes (`citationsOf`, `loadProposalCitations`),
  threaded `TaskPayment.citations` → `PayoutForMetadata.citations`; the
  transaction page links each `#N` (`citedProposalNumbers` →
  `TxPageData.citedProposals`). The chain import shows `g` and never
  restores `tasks.proposal_id` from it.
- **Manual payments** (`kind = 'payment'`, Payments page, `/api/tx/build-payment`)
  share label 190001 with a distinct record built only in
  `src/lib/cardano/paymentMetadata.ts`: `v` (1), `src`, `t: "payment"`, `c`
  (community slug), `b` (one period, `""` when every output is a transfer), `k`, optional `m` (memo), `o = [[outputIndex, [amount…], flag], …]`
  with flag 1 for a transfer to a sibling treasury, optional `g =
  [[proposalNumber, contentHash], …]` (the treasury budget's proposal for the
  period, plus a `proposalId` named in the request, accepted only as a passed
  and applied budget proposal of the community). It has no `p`, so the
  payout readers never match it. Rows live in `payments` (per recipient
  address and unit); `recipient_treasury_id` set ⇔ transfer ⇔ no
  `budget_month`. Admins or base signers of the paying treasury build (on
  the recovery path, admins or recovery signers: `requirePathBuilder`); sign,
  submit and the poller are kind-agnostic. Payments never write
  `community_assets`.
- **The spending check** (`src/lib/governance/spendCheck.ts`, pure; run by
  `guardSpend` in `spendGuard.ts` from build-payout and build-payment only
  while the community's budget kind is on): lines = (owner key, period month,
  unit, amount × assignees) against `budgetInForce` and what is already
  spent (`src/lib/db/spendCheck.ts`: the Dashboard's rules plus the rows of
  pending transactions; transfers are never lines). Problems `no_budget`,
  `over_budget` (per unit), `budget_not_voted`; texts in `spendProblemText`.
  `governance_community_settings.spend_check` (0059, one row per community,
  `save_governance_community_settings` logs to `governance_setting_changes`
  with `kind = 'community'`) picks **warn** (default: problems stored in
  `transactions.spend_problems` for the transaction page, never recomputed)
  or **refuse** (400 with the texts). The later co-signer runs the same
  function, and every problem refuses there, whatever the setting.
- **Outside-spend alerts** (0059, `src/lib/discord/notifyOutsideSpends.ts`,
  pure `outsideSpendMessage.ts`): after the treasury sync, an `external_txs`
  row the chain import is done with (`payout_meta` null or `import_status`
  set) and `governance_alerted_at` null is posted once to
  `governance_discord_webhooks` when the budget kind is on; with the kind
  off, no webhook or a dead webhook it is stamped
  without a post (never posted late; the migration stamps history); no
  wallet or name. `external_txs` has two FKs to `treasuries`, so its embed
  names `external_txs_treasury_id_fkey`. The Treasury page reads such rows
  **Built outside Treasury Guild** while the budget kind is on.
- **Proposal anchors** (migration 0060, label **190002**, the one home
  `src/lib/cardano/anchorMetadata.ts`): `{v:1, src, c, a}` with one positional
  entry per (proposal, step): `[n, "proposed", contentHash, rulesHash]`,
  `[n, "opened", electorateHash]`, `[n, "closed", state]` for a proposal
  closed without a vote, else `[n, "closed", state, tallyHash, [electorate,
  ballots, [[choice, count]…]], [store, locator]?]` (the copy only when one
  exists in the community's chosen store). Numbers, states and hashes only,
  every string ≤ 64 bytes; the strict parser is `parseAnchorMetadata` (null
  for the phase-0 test record `{v, src, c, test:1}`, which the `/dev` tool
  still builds). Label 190002 never carries `src: "treasury-guild"` with a `p`
  or `t`, so the chain import never sees an anchor. **Electorate hash**:
  `open_proposal_voting` stores `proposals.electorate_hash` = sha256 hex of
  `"<wallet> <0|1>"` lines (1 = recused) sorted `collate "C"`, joined by
  `\n`; `src/lib/governance/electorateHash.ts` computes the same with a
  plain `<` sort (never `localeCompare`; the shared vector is pinned in its
  test and `supabase/tests/anchors.sql`). `ballotText` signs it as an
  `electorate:` line only when set, and the tally body carries
  `proposal.electorateHash` (null for proposals opened earlier, whose ballots
  keep the shorter text; `checkTallyDocument` rebuilds whichever applies).
  **Due rules** are pure in `src/lib/governance/anchors.ts` (`anchorStatus`,
  `dueAnchorSteps`, `anchorEntryFor`): only `proposals.anchored` proposals
  (false for those final at the migration); proposed from creation, opened
  once voting opened with an `electorate_hash` (never for a proposal opened
  before 0060), closed once final and, after a vote, once frozen and
  (not published, or a copy exists, or a day passed); a proposal closed
  without a vote gets a closed anchor only when a proposed one exists. A
  step is anchored when a linking transaction is confirmed, pending while
  awaiting signatures, submitted once broadcast, due again once rejected or deleted. Links live in
  `proposal_anchors` (member-readable, pk `(proposal_id, step,
  transaction_id)`, cascade on the transaction), written only by the
  `record_proposal_anchors` RPC from the build routes inside
  `withTransactionRow` (pending transaction, the community's anchored
  proposals only).   `loadDueAnchors` (`anchorsDue.ts`, server) is the one
  loader: build-payout and build-payment attach as many due anchors as fit
  in `MAX_METADATA_JSON_BYTES` minus their own record (`attachAnchors`),
  loading them best effort (`loadDueAnchorsBestEffort`: a load failure logs
  and builds without), `POST /api/tx/build-anchor`
  (treasury actors; `TxKind.Anchor`, `buildAnchorTx`, no outputs) carries
  what fits alone, and `GET /api/proposals/anchors-due` feeds the pages'
  notice. **Discord reminders** (0070, `notifyAnchorsDue`, pure
  `anchorMessage.ts`): after freeze/publish in the reconcile sweep, a due
  step that has sat for `ANCHOR_STALE_MS` (3 days) or a closed step in the
  last `COPY_GRACE_REMINDER_BEFORE_MS` (6h) of the copy-grace window is
  posted once per `(proposal, step, kind)` episode (`proposal_anchor_alerts`,
  keyed by `due_since`) to `governance_discord_webhooks`; connecting stamps
  current candidates without posting; a dead webhook stamps without a post;
  numbers and steps only. The confirm poller stamps `transactions.block_time` from Koios
  `tx_timestamp`; the proposal page shows it beside `voting_opened_at`. The
  Verify button (`VerifyRecord.tsx`) runs `checkTallyDocument` in the
  browser (`tallyDocument.ts` is client-safe: no `Buffer`; loaded by dynamic
  import) and `compareAnchors` (`verify.ts`) on records from
  `GET /api/chain/tx-metadata` (Koios CBOR, hash checked with core-cst).
  `proposal_list` exposes `contentHash`, `rulesHash`, `electorateHash`,
  `tallyHash` and confirmed anchor tx hashes. Mints carry no anchors.
- **Fund this budget** (`src/lib/governance/fundBudget.ts`, pure): on a
  passed + applied budget proposal, admins get a link per workgroup step
  whose routing (`routedTreasuryAt`) resolves to one treasury for the funding
  period (the step's own period, or the current one of a recurring step)
  when the community has ≥ 2 treasuries. `routes.payments(slug, prefill)`
  carries `?to=&month=&proposal=&amounts=unit:display,…`
  (`src/lib/payments/prefill.ts`, parsed by the Payments page into one
  transfer row; the build body then names `proposalId`, which the route
  re-checks as an applied budget proposal). Amounts are `formatQuantity`
  strings, never `formatUnits`.
- **Budgets are owned by a workgroup or a treasury** (migration 0036: nullable
  `workgroup_id`/`treasury_id` with a stored `owner_key`, `save_budget_setup`
  takes `p_treasury_id`, `budget_setup_workspace` lists both owner types with
  `ownerType`/`ownerId`). A workgroup budget consumes task payouts; a treasury
  budget consumes the manual payments made from it (transfers excluded).
  Reset stays workgroup-only. A save with no setup in force at its start (and
  no legacy conflict) is a **backfill** (migration 0051, `isBackfill` in
  `src/lib/budgetSetups.ts`): it may start in the past (reason required, like
  any past correction), runs until the owner's first setup instead of being
  refused by the later-setup guard, and must end on a quarter month when it or
  that setup is quarterly. Past mode/cadence switches of existing setups stay
  refused.
- **Task assignees live in `task_assignees`** (`src/lib/assignees.ts` is the
  one home for the pure logic; the service-role writers
  `replaceTaskAssignees`, `syncGithubAssignees` and
  `fillAssigneeWalletsByLogin` are in `src/lib/db/taskAssignees.ts`). `'github'` rows mirror the issue's assignee list
  and are owned by the sync (`syncGithubAssignees`): added on assign, removed
  on unassign, wallet filled from `contributors.github_username` only while
  null and never overwritten by the sync. The task editor's writes are
  `POST /api/tasks/assignees` only (service role; admin or workgroup lead;
  refuses archived and settled tasks, a wallet on the other network and a
  GitHub row listed twice): it replaces the `'manual'` rows and may set the
  wallet and position of a `'github'` row, all in one step through the
  `replace_task_assignees` RPC (migration 0063: task row lock, refused once the
  task is queued, paid, reconciled or in a live payout). The other writers of
  `'manual'` rows are three RPCs: `finalize_call`, `import_chain_tx` and
  `apply_task_proposal`. There are no client write policies. **Every
  assignee is paid the task's full amounts** (N assignees = N× the bounty),
  one tx output per distinct wallet (`src/lib/cardano/payoutRecipients.ts`);
  a task is buildable only with ≥1 assignee and every assignee linked.
  `payouts` rows are per (transaction, task, wallet, unit).
- **Call attendance** (migration 0037, `src/lib/calls/`, `src/lib/db/calls.ts`):
  a finalized call becomes ordinary **native** tasks (`tasks.source` gets no
  third value: `<> 'native'` means GitHub everywhere), titled
  `Call: <title>, <date>`, payable, one `'manual'` assignee per attendee
  wallet, linked through `call_tasks` / `call_attendees.task_id`. They are
  created only by the `finalize_call` RPC (row lock, only attendees without a
  task, so a retry never pays twice; `finalizeReady` in
  `src/lib/calls/finalize.ts`, shared by the route and the agent API, calls
  it through `finalize_call_at_reward`, migration 0063, which refuses when the
  reward changed since the bounty was derived), in balanced chunks of at most
  `MAX_TASK_ASSIGNEES` (a task cannot span transactions and the task editor
  reposts the full assignee set). Once a call has attendance tasks its reward
  is locked and it cannot be deleted, both checked under the call's row lock
  (`set_call_amounts`, `delete_call_without_tasks`, 0063), so a finalize cannot
  slip in between. A wallet appears once per call
  (`call_attendees_wallet_uq`); every wallet-setting path relies on it. Who
  qualifies is decided in `src/lib/calls/qualify.ts`. All call writes are
  service-role routes (admin or lead of the call's workgroup), except the
  attendee's own check-in; the check-in
  code lives in `call_checkin_codes` (no policies) and doubles as an invite:
  `POST /api/calls/[id]/checkin` joins the wallet to the community.
  build-payout, payout metadata and Payday know nothing about calls.
- **Discord voice capture** (migration 0039, `src/lib/calls/capture.ts`): there
  is no always-on bot. A run opens **one** short-lived gateway connection
  (`discordGateway.ts`, global `WebSocket`, Node 22 pinned in `netlify.toml`;
  intents GUILDS | GUILD_VOICE_STATES, none privileged) for all the servers it
  needs, because IDENTIFY is rate limited per bot: the cron never connects per
  call. The manager's capture-now (`captureCallNow`,
  `/api/calls/[id]/capture`) is the one single-call connection, held to one
  per call every `MIN_SNAPSHOT_GAP_MS` (30 s): the latest snapshot is checked,
  then the `callCapture` rate limit (per call) is claimed atomically, so two
  clicks at once cannot both connect.
  Snapshots are written only by the `record_call_snapshot` RPC, which puts
  each person on exactly one attendee row (their Discord row, else the row
  already carrying their linked wallet, else a new one) and **recomputes**
  `snapshots_seen` from `call_snapshot_attendees`. The community's server is
  `call_integrations`; its id comes from Discord's token response in
  `/api/discord/guild-callback`, never from a query parameter. A host
  connection and its tokens are saved in one step (`save_call_integration`,
  0063). Re-pointing to another account cleans up the old one once the new
  one is saved: the bot leaves the old server, and the replaced Google grant
  is revoked. A failed save takes the bot back out of the new server, and so
  does a callback refused before the save (bad state, no session, another
  wallet, no longer an admin): Discord adds the bot at consent, so the
  adapter's optional `abandon` hook (`HostLinkAdapter`) exchanges the code only to learn that server, saves
  nothing, and leaves it. A consent whose callback never arrives is caught by
  the calls-sync cron's `leaveOrphanGuilds` (`capture.ts`): **production
  only** (a local stack sharing the bot would see production's servers as
  orphans), it leaves servers no `call_integrations` row names once the bot
  has been in them `ORPHAN_GUILD_GRACE_MS` (an hour), at most
  `ORPHAN_GUILD_BATCH` (10) per run, re-checking the connection just before
  leaving. None of
  this happens to an account another community still uses
  (`accountConnectedElsewhere`; a Google disconnect obeys the same rule,
  since revoking ends the account's whole grant). A connect step whose
  provider client id is missing redirects back with
  `reason=oauth_env_missing`, as the callbacks do.
  `call_attendees.external_id` is not selectable by `authenticated` (column
  grants) and is absent from `CallAttendeeRow` / `CALL_ATTENDEE_COLUMNS`; the
  same holds for `call_attendee_sessions.source_key` and
  `call_integrations.external_account_id` (migration 0048), whose full row
  is the service-role `CallIntegrationRecord` /
  `CALL_INTEGRATION_RECORD_COLUMNS`.
- **Zoom capture** (migration 0040, `src/lib/calls/zoomCapture.ts`): presence is
  **sessions** (`call_attendee_sessions`, unique `source_key`), written only by
  the `record_call_sessions` RPC; `minutes` is always recomputed as the union
  of an attendee's sessions clipped to `starts_at..ends_at`
  (`recompute_call_minutes`), so the webhook and the report describing the same
  stay never add up. `POST /api/zoom/webhook` verifies `x-zm-signature` over
  the raw body (401 otherwise), answers `endpoint.url_validation`, drops the
  connection on `app_deauthorized` (`deleteIntegrationsByAccount`), answers
  200 even when recording a join, leave or `meeting.ended` fails (Zoom disables
  endpoints that keep failing; the replay check and the deauthorize delete are
  deliberately not caught, so Zoom redelivers) and **never stores a payload** (they carry emails); a signed request seen
  before is ignored (`markZoomDeliverySeen`: only `sha256(x-zm-signature)`
  in `zoom_webhook_deliveries`, migration 0047, purged after 10 minutes by
  the calls-sync sweep), so a replay inside the signature window does nothing; it is not the source of
  truth: the `calls-sync` cron reads the participant report of ended calls
  (`calls.captured_at`). A meeting maps to the open Zoom call with that
  `external_ref` around the event time, in a community connected to the
  sending `account_id`. Host tokens live in `call_integration_secrets` (no
  policies); Zoom refresh tokens rotate, so a refreshed pair is saved before
  use (`zoomApi.ts`). Guests are keyed `name:<normalized name>`. An event of
  a connected account that matches no call is **parked**, not dropped
  (`call_pending_sessions`, migration 0042, no policies: a bare session with
  no wallet and no payload), because hosts open the meeting before creating
  the call. It is replayed through `record_call_sessions` when a call comes to
  name that meeting (`replayPendingZoomSessions` on call create / edit, and
  ahead of the next live event) and purged after 24 hours by the cron; the
  privacy policy states that retention. Parked events surface to managers only
  as **detected meetings** (`GET /api/calls/detected`, `groupDetectedMeetings` in `zoomSessions.ts`:
  topic, times, a participant count, never names).
- **Linked meetings** (migration 0043, `call_meeting_links`, member-readable,
  written only by `/api/calls/meeting-links`; a link of an archived workgroup
  is frozen like its calls): a Zoom meeting id tied to a
  workgroup with a title, reward, threshold and usual length. A **join** to a
  linked meeting that no call covers creates the call in
  `recordZoomParticipantEvent` (`insertLinkedCall`): `calls.meeting_link_id`
  plus `calls.external_instance` = Zoom's meeting **uuid**, unique per
  community and provider (`calls_external_instance_uq`), so concurrent first
  joins cannot create two. Events find such a
  call by uuid before the id-and-time-window match, its report is read by uuid
  (a numeric id only answers for the latest occurrence), and its `ends_at`
  follows the meeting: a later leave extends it, `meeting.ended` sets it.
  Only calls with `external_instance` move on their own; a hand-made call's
  times are the manager's. A link's `provider` is the call platform (`'zoom'`
  or `'meet'`, migration 0044). **Meet links have no join event**: the
  `calls-sync` cron lists each linked code's conference records
  (`discoverLinkedMeetCalls`) and creates the call of a new one, with
  `external_instance` = the conference record name; which records qualify
  (running, or begun after the link and ended within the hour, so a deleted
  call does not come back for a day) is `linkedOccurrence` (`meetSessions.ts`,
  with `followedEnd` and `pickConferenceRecord`), and the end moves
  by `followedEnd` **before** sessions are recorded (minutes are clipped to the
  call's times). Such a call picks its record by name, not by
  `pickConferenceRecord`. Unlinked Meet rooms are never read. Unlinked meetings are never listed automatically
  (members read calls; the privacy policy promises only chosen meetings show).
- **Attendance tasks take the call's budget period**: the finalize
  (`src/lib/calls/finalize.ts`, shared by the finalize route and the agent
  API's `call_finalize`) stamps `budget_month` from `calls.starts_at` via
  `taskBudgetPeriod` right after `finalize_call` (`setBudgetMonthIfNull`,
  best effort; build-payout still stamps whatever is unset).
- **Google Meet capture** (`src/lib/calls/meetCapture.ts`, no webhooks): the
  `calls-sync` cron polls Meet REST v2 as the connected organiser account
  (`call_integrations.provider = 'google'`, scope `meetings.space.readonly`,
  refresh token in `call_integration_secrets`): running Meet calls every run,
  ended ones until final (`calls.captured_at`). It records
  `participantSessions` through the same `record_call_sessions` RPC, keyed by
  the session resource name, so re-reading only fills in end times. A
  signed-in participant's `users/<id>` equals the OpenID `sub` in
  `contributor_identities`: an exact match; guests go through name matching.
  `calls.external_ref` is the meeting code; a reused code resolves to the
  conference overlapping the call (`pickConferenceRecord`). The host grant
  (`/api/google/host-connect`) is distinct from the personal `openid` link.
- **Linked accounts** beyond GitHub live in `contributor_identities`
  (migration 0038: `discord` user id, `google` OpenID `sub`), written only by
  the service-role OAuth callbacks (`src/lib/oauth/identityLink.ts`, routes
  `/api/discord/oauth-callback`, `/api/google/oauth-callback`; the
  `guild-*` / `host-*` routes beside them are host connections, as are
  `/api/zoom/connect` + `/api/zoom/oauth-callback`: Zoom has no personal link). Scopes stay minimal (`identify`,
  `openid`) and no provider token is stored. RLS shows a wallet **its own rows
  only**: platform account ids never reach other members, which the privacy
  policy (`src/content/docs/privacy.mdx`) promises, so capture code must keep
  them out of member-readable columns. Every OAuth / install `state` is signed
  in `src/lib/oauth/state.ts` (key `OAUTH_STATE_SECRET`, else one derived from
  `CRON_SECRET`) and bound to a purpose; a callback accepts only its own. A change to what is stored about a person updates the privacy
  policy in the same change.
- **Koios is server-side only** (no CORS headers). The browser goes through
  `/api/chain/*`. Mesh provider access flows through
  `getProvider()` (`src/lib/cardano/provider.ts`) as `IFetcher & ISubmitter`;
  raw Koios endpoints (`/tx_cbor`, `/asset_info`, address txs) only through
  `src/lib/cardano/koios.ts` (`server-only`).
- **RLS reads the `wallet` claim** via `jwt_wallet()` — never `auth.uid()`
  (sub is a bech32 address, not a UUID). Session JWTs are minted with the
  Supabase legacy JWT secret in `src/lib/auth/jwt.ts`. The 7-day session is
  the httpOnly cookie only; `/api/auth/token` gives the browser client a
  fresh 15-minute `mintAccessJwt` token (never the cookie's bytes), which
  `src/lib/supabase/browser.ts` re-fetches by its `exp`. Login
  (`/api/auth/verify`) needs the CIP-30 signature to come from the address's
  **payment** key (`signedByPaymentKey`, `src/lib/auth/walletSignature.ts`);
  Mesh's `checkSignature` alone also accepts the stake key. Login challenges
  (`auth_nonces`, keyed by the challenge since 0063) may be several per
  address, so asking for someone else's never replaces theirs: verify names
  the challenge it signed, `/api/auth/nonce` is limited per IP only (never
  per address, whose budget anyone could spend), and the reconcile sweep
  purges expired ones.
- **Response headers** (`next.config.ts`): framing refused
  (`X-Frame-Options: DENY`, `frame-ancestors 'none'`) so signing pages cannot
  be clickjacked; no script CSP (Mesh WASM + Next inline bootstrap).
  `contributors` is not readable by `anon` (0046).
- Treasury/transaction/payout **writes go through service-role API routes**
  that authorize in code; there are deliberately no client write policies on
  those tables.
- **Browser task writes are column-granted** (migration 0046): insert
  `(workgroup_id, title, column_id)`, update only the board / task-editor
  fields. `guard_task_client_write` lets an `authenticated` caller move
  `pay_state` only between `none` and `payable` on a native task and freezes
  amounts / `budget_month` of a task in a payout. build-payout also refuses a
  task with payouts rows in a non-rejected transaction. A new browser-written
  task column needs a grant. Because the insert cannot carry `pay_state`, the
  `task_payable_from_column` insert trigger (migration 0049) makes a native
  `'none'` task inserted into a `marks_payable` column audited and payable.
- **Task deletion is guarded** by `guard_task_lifecycle` (migrations 0021,
  0041): never a task that is past `payable` or has payouts rows; a native
  task only once archived; a GitHub task (which cannot be archived) only by
  the service-role sync, when its issue leaves the import filter.
- **Payout announcements**: a confirmed payout is posted to the treasury's
  Discord channel (`src/lib/discord/notifyPayouts.ts`, webhook in
  `treasury_discord_webhooks`, migration 0027; fiat footer from
  `src/lib/rates/coingecko.ts`) and written back to GitHub (tx-hash comment,
  paid label, move to the Paid status: `src/lib/github/writeback.ts`).
- **GitHub App install** (`/api/github/setup`): the state is a wallet-bound
  `github-install` OAuth state; `installation_id` is a spoofable query
  parameter, so `installationClaim` never moves an installation another
  community holds and accepts an unclaimed one only when GitHub created or
  updated it in the last 15 minutes. Repo links are checked against the
  installation (`GET /repositories/{id}`), never trusted from the body.
- **Rate limits**: abuse-prone routes call `enforceRateLimit(bucket, subject)`
  (`src/lib/db/rateLimit.ts`, budgets in `RATE_LIMITS` in
  `src/lib/constants.ts`, `hit_rate_limit` RPC,
  service role only; counters purged by the reconcile sweep after a day, as
  the privacy policy states). IPs come from `clientIp`. Unexpected 500s show
  their message only outside production.
- **Agent API** (migrations 0053-0054, 0064-0065; MCP at `/api/mcp`, REST at `/api/v1/*`,
  developer notes in `src/app/api/mcp/README.md`, modelled on the multisig
  repo's): each read, preview or confirm is one endpoint in `src/lib/api/v1/*` (`defineEndpoint`:
  scope + zod input + `run(caller, input)`, which does all authorization,
  `memberCommunity` for community slugs), served by `v1Route` /
  `v1PostRoute` and the MCP tool registry `src/lib/mcp/tools.ts`: write
  each check once there, never in a route or tool. Shared helpers:
  `src/lib/api/v1/shared.ts` (`memberCommunity`, `resolveCommunityWorkgroup`
  / `resolveCommunityTreasury`, `communityMemberRefs`, `appLink`, and a
  `requireMember` that is name matching, not the `authz.ts` check) and the
  pure `shape.ts` (`matchMembers`, `CONFIRM_NEXT`, answer shaping). The caller (`src/lib/api/caller.ts`) is an OAuth
  access token, or on `/api/v1` only the session cookie (every scope);
  `/api/mcp` never accepts the cookie, refuses any `Origin`, and builds a
  fresh `McpServer` per request (`createMcpHandler`, nothing at module
  scope). Both charge one per-wallet `agentApi` rate limit. Every request
  **re-reads `oauth_grants`**, intersects scopes and requires the token's
  `gat` claim to equal the grant's `created_at`, so Settings' Disconnect
  bites on the next call and a later re-approval never revives old tokens.
  Access tokens (`src/lib/oauthServer/accessToken.ts`) are signed with
  `mcpTokenSecret` (`MCP_TOKEN_SECRET`, **required in production**; the
  `CRON_SECRET`-derived key is dev/test only), **never
  `SUPABASE_JWT_SECRET`**, typed `tg_mcp_at` / `at+jwt`, audience
  `${APP_URL}/api/mcp`, issuer `APP_URL` (never the Host header). The
  authorization server (`src/lib/oauthServer/`, apart from the OAuth
  *client* plumbing in `src/lib/oauth/`) does CIMD (SSRF-guarded fetch) and
  DCR, PKCE S256 only, loopback redirects match with the port ignored, and
  the consent page (`/oauth/consent`) carries a `mcp-authorize` handle signed
  by `src/lib/oauth/state.ts`: the handle says what, the session cookie
  says who, ticked scopes only narrow; it shows the CIMD domain as the
  client's identity (`verifiedDomain`) and flags a DCR name as self-declared,
  and a refusal reaches it only as a code (`consentErrors.ts`), never text.
  Codes, refresh tokens and client secrets are sha256 hashes; redemptions
  are conditional updates, and a replayed code or rotated refresh token
  **deletes the grant** (every token of that connection dies at once).
  `purge_oauth` (reconcile sweep) also drops ungranted CIMD clients unseen
  for a day. Scopes live in
  `src/lib/mcp/scopes.ts` (`communities:read`, `proposals:write`,
  `tasks:write`, `payouts:write`) and the 401 challenge names all of them; a
  write scope is never in a scope-less request's default (`READ_SCOPES`) and
  starts unticked on the consent page. **Only `proposal_create` and
  `draft_confirm` write** (`src/lib/mcp/tools.test.ts` pins the list, the two
  writers and each write scope's previews): every write needs its `:write`
  scope and a human confirmation step (multisig's preview → token →
  propose). A `*_preview` tool runs the app's own checks and writes nothing;
  its draft token (`src/lib/mcp/draftToken.ts`: 15 min, own key, bound to
  wallet + client + grant `created_at`, `act` names the action; a token
  without `act` reads as `proposal_create`) is what `proposal_create`
  (proposal drafts only) and `draft_confirm` (every action of
  `DRAFT_ACTION_DEFS` in `src/lib/api/v1/drafts.ts`, proposals included, the
  action's own scope checked inside) take, beside an optional `community`.
  Each confirm re-checks (state-dependent previews also compare a
  fingerprint), and confirming a draft twice does its change once, even
  concurrently: a create is keyed by the draft (`agent_draft_id`, unique:
  `proposals` via `create_proposal_from_draft`, 0064; `transactions`,
  `tasks`, `calls`, 0065; members can read it, which the privacy policy
  says); a withdraw (already withdrawn by the caller), a task edit (the task
  already reads as the preview's after) and a call finalize (nobody left to
  pay; the repeat lists no tasks) answer from the state instead. Proposals:
  creation checks are `src/lib/governance/propose.ts`, shared with
  `/api/proposals`; `draftFingerprint` (not `content_hash`,
  which a budget's resolved amounts make differ), budget changes become the
  Budgets page's saves with the owner's current revision. Payouts:
  `src/lib/payout/build.ts` (`planPayout` = every build-payout check plus the
  unsigned tx, no writes; `persistPayout`), shared with
  `/api/tx/build-payout`, whose route is only these two calls (so
  "build-payout" in this file means `build.ts`); a confirmed payout is only the treasury's pending
  transaction for its signers. Tasks: native boards only, created in the
  first column neither payable nor paid, edited only while `pay_state =
  'none'` by a conditional update; columns and `pay_state` never written.
  Calls: `src/lib/calls/create.ts` / `finalize.ts`, shared with the routes
  (a draft's create passes its `communityId`, refused before the insert).
  Reads that bypass RLS gate in code (`ballotsVisible`,
  `CALL_ATTENDEE_COLUMNS`); service-role mirrors of a page's RLS reads
  change together with it (`src/lib/db/txDetail.ts` ↔ `txPage.ts`,
  `loadFundingOverview` ↔ `useFunding`). Leads and `member_list` match members
  by full wallet, handle or GitHub login, in that order; REST writes are `v1PostRoute`, cross-site
  refused; no tool ever signs, submits or votes. Tool results carry member-written text,
  so the server instructions say to treat it as data. A new tool or field
  updates `src/content/docs/ai-assistants.mdx`, and the privacy policy when
  it changes what is stored.
- **Treasury import** (`src/lib/cardano/treasuryImport.ts`,
  `/api/treasury/import/preview`, page `/c/[slug]/treasury/import`): an
  existing script of one of the four template shapes (flat all/any/atLeast,
  clawback, lock-until or co-signer; `decodeTreasuryCbor` refuses any other)
  is adopted from its CBOR, one matching signer address per key (an imported
  co-signer is always the `member` kind, `lock_until` derived from the
  script's slot); the stored `script_cbor` keeps its key
  order (not CIP-1854 sorted), and `resolveTreasury` refuses a treasury whose
  script, signers and threshold disagree.
- **Treasury templates and spending paths** (migration 0061, doc phases 6
  and 7): a treasury's script has one of four fixed shapes, the one home
  being the client-safe `src/lib/cardano/templates.ts` (`templateScript`
  builds, `shapeFromDecoded` recognises exactly these and nothing else,
  `shapeProblem` checks group sanity): `plain` = base; `clawback` =
  `any[base, all[recovery, after(slot)]]`; `lock_until` = `all[base,
  after(slot)]`; `cosigner` = `any[all[base, sig(co)], all[every base
  key]]`, refused when the base rule already needs every base signer
  (`cosignerAllowed`). `treasuries.template` / `lock_slot` / `lock_until`
  (derived from the slot with `src/lib/cardano/slots.ts`, the slot is the
  truth) / `recovery_script_type` / `recovery_required` / `cosigner_kind`
  (`member` | `app`) exist exactly for the templates that use them (check
  constraint); `treasury_signers.signer_group` (`base`, `recovery`,
  `cosigner`; the pk refuses a key in two groups); `decodeTreasuryCbor`
  returns the `shape` and `buildTreasuryWallet` refuses any disagreement
  between the row, the grouped signer rows and the script. Base signers of
  the community's **primary** treasury (`communities.primary_treasury_id`,
  first treasury or admin re-point via `/api/treasury/primary`) become
  admins; later treasuries' base signers are members only and are the
  treasury actors for that wallet (`isSigner`, `signerTreasuryIds`,
  `isTreasuryActor` = base signer only — community admin alone cannot
  build; refund matching, `/api/reconcile/match`, is base signers only:
  `isTreasurySigner`); recovery signers and a member co-signer must already
  be members and are never promoted (`/api/members` refuses demoting a
  primary base signer and removes nobody who signs). Every transaction is built for one
  `transactions.spending_path` (`base`, `recovery`, `cosigned`, `bypass`;
  trigger `transactions_guard_path` refuses one the template lacks), resolved
  by `resolveSpendingPath` + `requirePathBuilder` in `src/lib/tx.ts` (build-payout
  checks `isTreasuryActor` itself, or `leadsAllWorkgroups` for a lead
  paying only their own workgroups: payouts never take the recovery path)
  (`pathOffered` in the client-safe `spendingPaths.ts`: lock-until builds
  nothing before the date, recovery is clawback-only from the date and
  payments only, recovery signers build it); the path's
  `SigningRule` (`pathRule`: members + `alsoRequired` co-signer) is what
  `thresholds.ts` counts by **address** on the sign, submit and reject
  routes and the signing page (`loadPendingTxForSigner` admits the path's
  participants only; the sign route returns `signedAddresses`). A
  recovery-path or lock-until transaction sets `invalidBefore` to the lock
  slot (`validFromSlotFor` → `completeTreasuryTx` / `buildMintTx`). The
  **co-signer check** (`src/lib/cosigner/check.ts`, pure comparison in
  `compare.ts`): the tx's own CBOR outputs equal the stored `payouts` /
  `payments` / `mints` rows rebuilt with `planOutputs`, the 190001 record
  names the same tasks / transfers, `spendCheck` in its strictest form (only
  while the budget kind is on; `loadSpentForTargets` takes
  `excludeTransactionId` so the tx never counts against itself), every `g`
  citation passed + applied + same content hash. The app-held key (`app`
  kind) is generated at creation (`src/lib/cosigner/keys.ts`, csl
  `PrivateKey`, AES-256-GCM under `COSIGNER_KEY_SECRET`, required in
  production) into `treasury_cosigner_keys` (no policies) and never rotated;
  its `treasury_signers` row is the enterprise address of the key hash with
  `COSIGNER_DISPLAY_NAME`; `cosignWithAppKey` (`sign.ts`) runs after a
  signature completes the base rule: best effort from the sign route
  (`CosignTrigger.Sign`, a failure never fails the signer), on demand from
  `POST /api/tx/[txId]/cosign` (treasury actors; 400 for a member co-signer)
  and from the sweep (`cosignReadyTransactions`); it first checks
  `resolveTxHash(tx_cbor)` against `tx_hash`, and the check narrows by kind
  (transfers: outputs only; anchors: change only; mints: the mint field);
  it signs through `mergeSignerWitnesses` + `add_signature`
  like a wallet, and records every run, signing failures included
  (`error`, 0062: a passed check whose witness could not be added; the sweep
  retries those hourly), in `cosigner_decisions`
  (member-readable). `GET /api/tx/[txId]/cosign-check` runs the check for
  the page (`CosignerCard`). Mints carry the co-signer too (the forge policy
  is the nested script). A community-run co-signer (7c) is not built.
- **One pending transaction per treasury** (`state = 0`, payout, payment,
  mint or anchor) — a second would spend the same UTxOs. Enforced by the
  partial unique index `transactions_one_pending_uq` (0059); `assertNoPendingTx`
  is the early check and `insertTransaction` maps the unique violation to
  the same 409 (`MSG.pendingTxExists`), so two racing builds cannot both
  land (a duplicate `agent_draft_id` maps there too; the payout confirm then
  answers from `findTransactionByDraft`). Communities can have several treasuries; a workgroup's wallet
  routing is the dated `workgroup_treasury_assignments` timeline (NULL = any),
  resolved per task budget period by `routedTreasuryAt`
  (`src/lib/workgroupRouting.ts`) in build-payout. `workgroups.treasury_id` is
  only the cached current-period value, written by the `set_workgroup_treasury`
  / `apply_workgroup_treasury_assignments` RPCs (migration 0035; the reconcile
  sweep applies scheduled changes), never by the browser.
- **Internal transfers** between a community's treasuries are tagged by the
  `tag_internal_transfers` RPC (poller, treasury creation): the receiver's
  `incoming_txs` row (`from_treasury_id`, type `transfer`, no review) is the one
  source of a transfer's amount; `external_txs.to_treasury_id` is written by the RPC and
  read only by the outside-spend alert (`toSiblingTreasury`), never for
  amounts.
  Dashboard income = inflows that are neither transfers nor refunds
  (`src/lib/fundingFlow.ts`).
- **Chain import** (migration 0045, `src/lib/chainImport/`,
  `src/lib/db/chainImport.ts`): an `external_txs` row whose transaction
  carries a Treasury Guild label-190001 record is rebuilt as the rows the app
  would have written (payout: `transactions` state 2 + `payouts` + paid
  tasks; payment: `transactions` + `payments`) and the external row is
  dropped. `pollTreasury` stays discovery-only; `syncTreasury` (the sweep and
  the on-visit sync) runs `importExternalTxs` after it, also when nothing new
  arrived, which is the backfill. The record and the outputs are read from
  the transaction's own CBOR (Koios `/tx_cbor`, hash checked with core-cst,
  outputs in body order), never from `external_txs.payout_meta`, which only
  selects candidates. Planning is pure (`plan.ts`: every issue collected, a
  tx imported completely or not at all); the only writer is the
  `import_chain_tx` RPC, whose `for update` lock on the external row is the
  idempotency guard (there is no unique index on `transactions.tx_hash`).
  Imported rows carry the block time in `created_at` / `submitted_at` /
  `discord_notified_at` (charts bucket on it; history is never announced).
  A task the record names is **kept** under its chain number when free,
  **settled** when that number is an unpaid task of the same workgroup with
  the same amounts and exactly the paid wallets as assignees, else held
  (`number_conflict`) until an admin imports it under a **new** number.
  `tasks.chain_number` is set on every import-created task (the "imported"
  marker; ≠ `number` when renumbered), is immutable, and is the one case
  where `assign_task_number` keeps a supplied number (`number =
  chain_number`); `tasks_insert` forbids it from the browser. Stub tasks are
  native, titled `Imported task #N`, retitled through the task dialog's
  **Save title** (a paid task's assignees stay locked). Recipients get a
  `contributors` row and a `'manual'` assignee, never a membership. What
  cannot be resolved stays in `external_txs` as `import_status = 'blocked'`
  with `import_issues` (`ChainImportIssueCode`, texts in `issueText.ts`) for
  the Treasury page queue; blocked rows are re-planned only by the admin
  routes (`/api/chain-import/workgroup`, `/api/chain-import/resolve`). A
  workgroup name an admin resolved is remembered in
  `workgroup_import_aliases`; names are compared truncated to the metadatum
  cap, as the builder writes them.
- **Previous-wallet history** (migration 0050, `src/lib/legacyHistory/`,
  `src/lib/db/legacyHistory.ts`, page `/c/[slug]/treasury/history`): a
  community's payments from the wallet it used before Treasury Guild, imported
  from an admin's CSV (`userId` = receiver address end, one column per token
  ticker, `task`, `date`, `workgroup`). Own tables only (`legacy_wallets`,
  `legacy_imports`, `legacy_payments`, `legacy_payment_amounts`; RLS, no
  policies, service role only): never tasks, payouts, transactions, payments
  or `community_assets`, and the wallet's `address` is a label that no chain
  code reads. Parsing and planning are pure (`parse.ts`, `plan.ts`); the
  preview and import routes re-parse the uploaded text (`planLegacyUpload`),
  never rows from the browser, and the only writer is the
  `import_legacy_history` RPC (wallet row lock; skips a line whose
  `dedupe_key`, sha256 of the canonical row, the wallet already holds unless
  duplicates are included; optional atomic replace of one import). A manual
  token unit counts only once Koios confirms the asset. `budget_month` comes
  from `taskBudgetPeriod`; amounts are read as `amount::text`. On the
  Dashboard a line is workgroup spend with the wallet id in the treasury slot
  (`legacyWalletLabel`), counted in budgets and in contributor/task counts
  (`legacyTaskKey`: workgroup + date + task text; `legacyContributorKey`:
  the one known wallet ending with the recipient ref, else the ref);
  `DashboardResponse.legacy` carries the wallets and token display. Recipients
  are stored as the address end and named at read time (`recipientLabel`). A
  workgroup with history cannot be deleted (`workgroup_lifecycle_status`);
  workgroup names resolved by an admin go to `workgroup_import_aliases`
  (normalized), shared with the chain import.
- **Funding sources** (migration 0052, `src/lib/funding/`,
  `src/lib/db/funding.ts`, page `/c/[slug]/funding`): outside funders and
  their commitments (`one_off` total, `recurring` amount per period,
  `schedule` with `funding_commitment_periods`), member-readable, written only
  by admin service-role routes (`/api/funding/*`; a schedule is replaced whole
  by the `save_funding_schedule` RPC). Planned amounts use the budget amount
  shape in base units, scaled server-side with decimals from ADA, the registry
  or Koios (`resolveFundingTokens`), never written to `community_assets`.
  Received = inflows tagged **whole** on the Incoming page (`/c/[slug]/reconcile`)
  (`incoming_txs.funding_source_id` / `funding_commitment_id`, guarded by
  `guard_incoming_funding`: same community, commitment of that source, never a
  transfer; a row that becomes a transfer loses its tag), counted by block
  time; planned vs received is pure (`plan.ts`). Schedule CSVs are read by
  `schedule.ts` on the shared `src/lib/csv.ts`. On the Dashboard a tagged
  inflow's Funding-flow source node is the funding source; refunds and
  transfers are still never income.
- **Proposals & voting** (migrations 0055-0057, `src/lib/governance/`,
  `src/lib/db/governance.ts`, pages `/c/[slug]/proposals`,
  `/c/[slug]/settings/governance`): kinds `decision` (nothing applied),
  `budget`, `workgroup` (`apply_workgroup_proposal`: a native workgroup with
  the payload's columns and the proposed leads still members; the name is
  checked by `workgroup_name_taken` when proposed and when applied; while the
  kind is on, `workgroups_insert` refuses the browser, the chain import's
  service-role create excepted) and `task` (`apply_task_proposal`, rewritten by 0059: a native
  task in the first column neither payable nor paid, `pay_state 'none'`,
  optional `'manual'` assignee = proposer; above the settings' lazy cap
  `taskExceedsLazyCap` escalates the method). What a proposal created is
  `proposals.execution_result`. Settings are one `governance_settings` row per
  community and kind (a missing row = off, defaults in `rules.ts`), saved
  only by `save_governance_settings`, which logs to
  `governance_setting_changes`. Every write is a governance RPC
  (`create_proposal`, `open_proposal_voting`, `cast_proposal_vote`,
  `close_proposal`, `execute_proposal`, `end_proposal`, which also serves
  withdraw and cancel), with lifecycle steps logged to `proposal_events`; the
  announcer's bookkeeping below is the one exception. Tables are
  member-readable, and `proposal_votes` RLS shows others' ballots only once
  `proposal_ballots_visible` (any state past `voting`, cancelled and
  withdrawn included, or `rules.hideResults` false). The
  rules are frozen onto the proposal (`rules` + `rules_hash`, with
  `content_hash`); `proposal_electorate` is the one home for eligibility
  (membership counted to the proposal's `created_at`, snapshotted into
  `proposal_voters` when voting opens), `tally.ts` the one home for outcomes
  (recorded by `close_proposal` against `ballot_version`). A ballot is a
  CIP-30 signature over `ballotText`, which the server issues
  (`/ballot`) and rebuilds (`/vote`) from its own data, verified by
  `verifyWalletSignature` (payment key, like login); the signed text, key and
  signature are stored. Deadlines are checked in SQL; the reconcile sweep
  (`advanceDueProposals`) and the proposal page's `/advance` nudge take due
  steps. **Budget consent**: with the budget kind on, `guard_budget_consent`
  refuses every insert/update of the budget tables unless
  `treasury_guild.proposal_apply` is set, which only `execute_proposal` and the
  `check_budget_proposal` dry run do (direct saves and resets surface as
  403). A budget proposal stores the worksheet's saves as resolved steps
  (`src/lib/db/budgetSave.ts`), locks each owner (one `active`
  `proposal_budget_owners` row per `owner_key`) and applies them all or
  nothing (`run_budget_steps`, which calls `save_budget_setup`) from each
  owner's base revision; a
  failure is recorded (`execution_state = 'failed'`), never retried by the
  sweep, only by an admin (`/execute`). Announcements (migration 0057,
  `src/lib/discord/notifyProposals.ts`, pure `proposalMessage.ts`): one
  service-role-only `governance_discord_webhooks` row per community, written
  with `proposals.discord_milestone` by plain service-role updates; the
  sweep posts each proposal's due milestone once (`dueMilestone`, recorded in
  `proposals.discord_milestone`, skipped milestones never posted late,
  connecting stamps the current one), never a voter's name or wallet. The
  signed tally (`/api/proposals/[id]/tally`, `tallyDocument.ts`) is served
  only once `ballotsVisible`; `checkTallyDocument` re-verifies it
  independently. Its body holds nothing that changes after the close (no
  `execution`). **Frozen documents** (migration 0059): once a proposal that
  reached voting is final, `freezeTallyDocument` (`src/lib/governance/freeze.ts`,
  after a close in `advance.ts`, after a cancel during voting, and the
  sweep's `freezeMissingTallyDocuments` for the backlog) stores the exact
  canonical JSON text and blake2b hash through the write-once
  `freeze_proposal_tally` RPC into `proposal_tally_documents`
  (member-readable); the tally route then serves that text byte for byte.
  Outside copies are one interface (`src/lib/storage/`: `DocumentStore`,
  `documentStoreFor` for a community — IPFS through Pinata, or GitHub
  Contents into an archive repo on the community's App installation —
  locators are a bare CID or `{repoId}/{blobSha}`; URLs from the
  client-safe `storage/locator.ts`) and one `proposal_document_copies`
  row per (proposal, store).
  `governance_community_settings.document_store` (+ `document_store_since`,
  and for GitHub `document_archive_repo_id` / `document_archive_full_name`)
  chooses where new documents go; the sweep's `publishTallyDocuments`
  publishes documents frozen since then that lack a copy, re-checks copies
  weekly and republishes from the database when one is gone; switching or
  turning off removes nothing. The agent API's `proposal_list` exposes a proposal's
  recorded `tally` only (set at the close) and the caller's own ballot,
  never others'; `proposal_detail` lists others' ballots only once
  `ballotsVisible`, as RLS does in the app. A new kind, field or rule updates
  `src/content/docs/governance.mdx`, and the privacy policy when it changes
  what is stored about a person.
- **No manual token registration**: payout tokens are discovered from the
  paying wallet (`src/lib/cardano/walletAssets.ts`, Koios `/asset_info` — never
  Mesh's `fetchAssetMetadata`, it is CIP-25-only) and matched to GitHub bounty
  field names by ticker (`src/lib/tokenMatch.ts`). `community_assets` rows are
  written by `persistPayout` (`src/lib/payout/build.ts`: the
  build-payout route and the agent API's payout confirm; auto-matches +
  manual Payday connections), by the chain import (a ticker found among the imported
  transaction's own output tokens, only when the registry has no such field
  name), and by `POST /api/github/project-field` when an admin/lead creates a
  GitHub bounty NUMBER field from a wallet-held unit (ADA never written), so
  post-payout displays keep stable tickers. Previous-wallet history
  keeps its own ticker and decimals per amount and never writes the registry.
- Signature appends use the `add_signature` RPC (optimistic concurrency on
  signature count, migration 0002; 0058 made a lost race return `false`
  instead of NULL); a `false` return means refetch + re-sign. Rejections are
  guarded the same way (`state` + signed/rejected lists, 409 `MSG.txChanged`).
- **A transaction's state and its tasks change in one RPC** (migration 0062,
  wrappers in `src/lib/db/transactions.ts`, each answering `false` when the
  row moved on): `confirm_transaction` (the poller: state, `block_time`,
  payouts, tasks paid), `reject_transaction` (the rejection; a dead
  transaction's queued tasks back to payable) and
  `delete_pending_transaction` (release, then delete). Never a second write
  from the route or the poller. The reconcile sweep's
  `release_orphaned_queued_tasks` (wrapper `releaseOrphanedQueuedTasks` in
  `src/lib/db/tasks.ts`) puts
  back a queued task with no payouts
  row in a pending, submitted or confirmed transaction. A failed build is
  cleaned up by `withTransactionRow` through `delete_pending_transaction`
  too, so tasks it had queued are released with the row. The poller's cursor
  never passes a hash Koios listed but did not describe (`_after_block_height`
  is inclusive, so the cursor stops at that block).
- `@meshsdk/react` 2.0's `signData` swaps argument order vs core 1.9 —
  signing always goes through `useMeshWallet` (bridges to the 1.9
  `BrowserWallet`), never `useWallet().wallet` directly.
- GitHub webhooks are **not** the source of truth; the hourly cron sweep
  repairs drift. `projects_v2_item` payloads are sparse → GraphQL follow-up.
- **In-app GitHub issue create and edits** (`POST /api/github/issue`,
  admins/leads of the workgroup; `src/lib/github/issueWrite.ts` over
  `projectsV2.ts`' writers): `kind: "create"` opens an issue on a linked
  repo (`createGithubIssue`), adds it to the project
  (`addProjectItemByContentId`) in the Status column the board's
  **Add issue…** box was under (repo picker when the workgroup has more
  than one linked repo; no payable label — the import rule still decides
  when it becomes a task); edits push title/body/labels/state, Project
  Status and bounty number fields to GitHub first, mirror locally
  (`mirrorGithubTaskEdit`), then re-sync so the import rule applies at
  once. Settled tasks accept title/body only. The other GitHub writes
  stay the payout write-back above; GitHub remains the source of truth
  for issue content either way.
- **Minting** (`kind = 'mint'` transactions): the forge policy is the
  treasury's own multisig native script, optionally wrapped as
  `{all:[script,{before:slot}]}` for a time lock — never a fresh key, so the
  normal sign/submit flow authorises it (`src/lib/cardano/mintBuilder.ts`,
  `mintMetadata.ts`). Label-721 metadata is built only in `mintMetadata.ts`
  and displayed by decoding the CBOR. Token images go to IPFS through Pinata
  presigned URLs (`/api/ipfs/sign-upload`, never SVG: it can carry scripts);
  `PINATA_JWT` is server-only.
  Mints never write `community_assets`; minted tokens are discovered from the
  wallet like any other (721-hint fallback in `assetInfo.ts`).
