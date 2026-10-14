# On-chain decision anchoring without smart contracts: scope and estimate

Date: 2026-09-30, updated 2026-10-01. Status: every decision is made and every
open question is answered. **Every phase is built** (migrations
`0059_anchoring_groundwork.sql`, `0060_anchors.sql` and
`0061_treasury_templates.sql`, applied locally and pushed to the remote;
`0062_atomic_tx_state.sql` later added `cosigner_decisions.error`
for a phase-7b signing failure). Each phase below ends with a **Built** note saying what landed
where and how it was checked. Phase 7c (a community-run co-signer) stays
unbuilt by decision.

Still open from the built phases:

- The preprod anchor test transaction is signed and confirmed, but its local
  row has no `block_time`, so the confirm poller's stamp is still unchecked.
- No frozen document has been published to Pinata for real (the adapter is
  covered by tests with a stub); the first admin who turns publication on
  exercises it.
- No anchor has been built, signed or confirmed for real yet: the attached
  and dedicated builds, the links and the due rules are covered by unit tests
  and the SQL fixture only, because the local snapshot holds no proposals.
  The first proposal made locally or on preprod exercises the due notice, the
  dedicated build, the proposal page's card and the prefilled Payments page;
  the confirm poller's `block_time` stamp and the Verify button's chain
  comparison are seen once an anchor lands.
- No templated treasury has been created or spent from on preprod: the
  shapes, the paths, the thresholds, the check and the app key are covered
  by unit tests and the SQL fixture only. The preprod runs the phase-6 and
  phase-7 notes list are what remains.

## Context

Community members have asked for smart contracts that record decisions
on-chain and allocate funds. A contract would add one thing the app cannot do
today: *enforcement* (funds cannot move unless a vote passed). That only works
if the vote and the electorate are on-chain too, which Treasury Guild's
membership-based voting is not.

The lighter alternative makes decisions *evident* instead of enforced:

1. Anchor each proposal's hashes on-chain in transaction metadata.
2. Make every spend cite the decisions that authorised it.
3. Use native-script treasuries, including time locks, for allocation.

4. Have the app check spends against the voted budgets, and offer a treasury
   whose normal spends need a co-signer that signs only what passes the check.

With 1 to 3 a spend against a vote is publicly provable. With 4 it is also
refused unless every signer acts together. It is still the app and the
signers, not the chain, that enforce the vote.

## Summary

The anchoring and checking work (phases 1 to 5) is a bit more than twice the
size of Funding sources. The time-lock templates (phase 6) are about as large
again on their own, because they change an assumption every treasury build
shares. The co-signer (phase 7) builds on phase 6's machinery.

| Phase | What | Size | Depends on | Status |
|---|---|---|---|---|
| 0 | Groundwork: pending-transaction index, preprod anchor test | Small | none | Built; preprod test tx confirmed (`block_time` unchecked) |
| 1 | Freeze the tally document, opt-in IPFS | Medium | none | Built |
| 2 | Spend citations, spending checks, outside-spend alerts | Medium to large | none | Built |
| 3 | Anchors: three steps, attached to payouts or sent alone; ballots sign the voter list | Large | 0, 1 | Built; preprod confirmation pending |
| 4 | Verify button and agent API fields | Small | 3 | Built |
| 5 | "Fund this budget" transfer prefill | Small to medium | 2 | Built |
| 6 | Time-lock treasury templates | Large | none | Built; preprod runs pending |
| 7 | Co-signer treasury template | Medium to large | 2, 6 | Built (7a, 7b); preprod runs pending; 7c by request |

Sizes are relative:

- **Small**: a few files, no schema change or a trivial one.
- **Medium**: a migration or a new record type, plus UI, docs and tests.
- **Large**: several of those together, or a change to an assumption that
  many modules share.

Phases 1 to 5 build on each other and can stop after any phase. Phase 6 is
independent and can ship before, after or never. Phase 7 needs phases 2
and 6.

## Decisions

All made on 2026-09-30.

| # | Question | Decision |
|---|---|---|
| 1 | Where the full tally document lives | Database, downloadable by members; a community can opt in to also pinning it to IPFS |
| 2 | How a spend cites a proposal | Proposal number and content hash |
| 3 | Which proposals a task's payout cites | Its own task proposal and the budget proposal for its period, both when both exist |
| 4 | When a proposal's first anchor is due | At creation (content and rules hashes); the voter-list hash follows when voting opens; the result at close |
| 5 | How anchors get on-chain | Attached automatically to any payout or payment built in the community; a dedicated anchor transaction for when none is coming |
| 6 | Who builds a dedicated anchor transaction | A treasury signer or admin, from an "anchors due" list, one transaction for everything due |
| 7 | Whether the lifecycle waits for anchors | Never. Voting opens and results apply on schedule |
| 8 | Whether anchoring is optional | Always on for a community that uses proposals and has a treasury |
| 9 | Existing proposals at launch | Only proposals created after launch or still open at launch are anchored. Already-closed ones get a frozen document but no anchors |
| 10 | Transfer prefill source | The admin picks the paying treasury when building |
| 11 | Time-lock scope | Two fixed templates: clawback and lock-until |
| 12 | Recovery signers' roles | Signers only: not made admins, must already be members, may build and sign recovery transactions from the lock date |
| 13 | Optional parts in scope | Verify button, agent API fields, transfer prefill, time-lock templates |
| 14 | Proving the voter list was fixed | Every ballot signs the electorate hash, so the list cannot change once a ballot exists |
| 15 | Spends the app builds | Checked against the voted budgets; a community chooses whether a failed check warns or refuses |
| 16 | Spends built outside the app | Announced to the governance Discord channel and flagged on the Treasury page |
| 17 | Limiting what can be misused | Documented practice: a reserve treasury plus operating treasuries funded per voted budget |
| 18 | Near-enforcement | A co-signer treasury template. The decision to sign is deterministic code, never an AI agent's judgement |
| 19 | Who holds the co-signer key | Per treasury: first a person (an elected auditor), then the app; a community-run co-signer later, on request |
| 20 | File storage | Behind one interface with copies recorded per document. IPFS is the first store; another can be added beside it, and old IPFS copies keep resolving |

Settled by checking the code:

| Question | Answer | Evidence |
|---|---|---|
| Does a metadata-only treasury transaction build? | Yes | Built offline with the repo's Mesh version: one script input, no outputs, change back to the treasury. 443 bytes and 0.19 ADA for one anchor; 8,300 bytes and 0.53 ADA for forty |
| Which metadata label? | 190002 | Not in the CIP-10 registry; 190001 is not registered either |
| Can the payout record stay v3? | Yes | Readers tolerate a new top-level key. The strict parser requires exactly four elements per task entry (`src/lib/cardano/metadata.ts`), so citations cannot go inside the entry |
| Can a voter's recusal change after voting opens? | No | `recused` is written only by `open_proposal_voting` (migration 0055), so it is part of the electorate hash |
| Which budget rows decide a period? | The setup and plan rows | `save_budget_setup` (migration 0051) writes exactly the `budget_setups` and `budget_plans` rows it changes, so stamping those rows answers "which proposal set this period" without a date rule |
| Must the tally document keep the app host? | Yes | Every ballot text names it and the verifier rebuilds ballots from it |
| Is the one-pending-transaction rule enforced by the database? | No | Only `assertNoPendingTx`; the sole index is non-unique (`transactions_treasury_state_idx`) |
| When is the voter list decided? | When voting opens | `proposal_electorate` (migration 0055) evaluates roles, leads and recent payouts at that moment; only the membership cutoff is the creation time. So the list cannot be anchored at creation without changing voting rules |
| Do the build routes enforce budgets today? | No | build-payout and build-payment resolve a budget period but never compare amounts with the budget |
| Are outside spends announced today? | No | The poller records them in `external_txs`; nothing under `src/lib/discord` reads that table |

## Metadata limits and what is stored where

Protocol parameters read from Koios on 2026-09-30 (mainnet, epoch 658):

| Limit | Value | What it means here |
|---|---|---|
| Max transaction size | 16,384 bytes | Covers inputs, outputs, witnesses and metadata together; there is no separate metadata limit |
| Fee | 44 lovelace per byte + 155,381 lovelace | An anchor attached to a payout costs well under 0.01 ADA; a dedicated anchor transaction about 0.19 ADA |
| String or byte value | 64 bytes each | A sha256 or blake2b-256 hash as hex is exactly 64 |
| App's own guard | 10,000 JSON bytes | `MAX_METADATA_JSON_BYTES`, already applied to payout and payment records |

Metadata is permanent and public, and scripts cannot read it. Cost is not the
constraint; transaction size and privacy are. Communities are private by
default, so nothing member-written goes on-chain.

| Data | Rough size | Where |
|---|---|---|
| Spend citation | About 75 bytes per cited proposal, plus its task numbers | Metadata, label 190001, key `g` |
| Proposed anchor: content and rules hashes | About 140 bytes | Metadata, label 190002 |
| Opened anchor: electorate hash (also signed by every ballot) | About 75 bytes | Metadata, label 190002 |
| Closed anchor: final state, tally hash, counts, optional CID | About 100 to 170 bytes | Metadata, label 190002 |
| Proposal title and body | Up to kilobytes | Off-chain |
| Voter list | About 110 bytes per wallet | Off-chain |
| Ballots | About 2 KB each in the JSON document | Off-chain |

A hundred ballots are roughly 200 KB, over twelve full transactions, so
ballots never go on-chain.

IPFS solves availability, not integrity: the on-chain hash already proves a
document is unchanged. It is public, cannot be reliably deleted, and
disappears unless someone keeps pinning it. A CIDv1 with the `ipfs://` prefix
is 66 characters, over the 64-byte cap, so the anchor stores the bare CID.

## What already exists

As found before the work started (the "What is missing" list below is the
same snapshot; phases 0 to 6 have since closed all of it).

- **Signed ballots.** Each ballot is a CIP-30 signature over `ballotText`
  (`src/lib/governance/ballot.ts`), which commits to the proposal's
  `content_hash` and `rules_hash`.
- **Content and rules hashes.** sha256 over canonical JSON
  (`src/lib/governance/hash.ts`), fixed at creation.
- **A hashed tally document.** `src/lib/governance/tallyDocument.ts` builds
  `{ hashAlgorithm: "blake2b-256", body, hash }`.
- **An independent verifier.** `checkTallyDocument`, client-safe, called only
  from tests today.
- **A shared treasury transaction builder.** `completeTreasuryTx` in
  `src/lib/cardano/payoutBuilder.ts` takes outputs and `[label, value]`
  metadata pairs; payouts and payments both use it.
- **Kind-agnostic signing.** Sign, submit, reject, delete and the confirm
  poller do not check `transactions.kind`.
- **The proposal id during apply.** `execute_proposal` sets
  `treasury_guild.proposal_apply` to the proposal id while it applies a budget.
- **Transfers between treasuries.** Payments to a sibling treasury are
  recognised server-side, flagged in metadata and tagged on the receiver.
- **Transaction CBOR from the chain.** `src/lib/cardano/koios.ts` reads
  `/tx_cbor` and `cborMetadata.ts` decodes metadata from it.
- **Nested-script witness filtering.** `nativeScriptUtils.ts` and
  `filterWitnessesToScripts` already walk nested scripts and time-lock nodes.
- **Slot-based locks.** The mint flow already takes a lock slot and sets
  `invalidHereafter`; Mesh's builder also has `invalidBefore`.

## What is missing

- ~~The tally document is rebuilt on every request and its hash is not stored.
  The body includes `execution`, so the hash changes after a passed proposal
  is applied.~~ Done in phase 1.
- ~~A created task has no link back to its proposal.~~ Done in phase 2
  (`tasks.proposal_id`).
- ~~A budget has no link back to its proposal, only the free-text reason
  "Proposal #N" in `budget_changes`.~~ Done in phase 2 (`proposal_id` on
  `budget_setups` and `budget_plans`).
- ~~No page runs `checkTallyDocument`.~~ Done in phase 4 (the Verify button).
- ~~There is no server-side pin of a JSON document.~~ Done in phase 1
  (`src/lib/storage/`).
- ~~The Payments page reads no URL parameters.~~ Done in phase 5 (the
  prefill query; there is still no saved draft).
- ~~Treasury scripts are assumed flat (all / any / atLeast over pubkeys)
  everywhere except witness filtering.~~ Done in phase 6 (`templates.ts`).
- ~~No builder sets `invalidBefore`.~~ Done in phase 6 (`validFromSlot`).

## Phase 0: Groundwork

- **Pending-transaction index.** Add a partial unique index on
  `transactions(treasury_id)` where the state is pending. The migration first
  checks that no treasury has two pending rows. `withTransactionRow` maps the
  unique violation to the existing "a transaction is already pending" error.
  This closes a race that anchoring would otherwise widen with a fourth build
  route.
- **Preprod test.** Submit one metadata-only anchor transaction on preprod
  through the normal sign and submit flow. Building is already confirmed; this
  confirms the ledger and the poller accept it.

**Built (2026-09-30).** The partial unique index is
`transactions_one_pending_uq`; the migration's guard block refuses to run
while any treasury has two pending rows. The mapping lives in
`insertTransaction` (`src/lib/db/transactions.ts`): a unique violation
becomes the same 409 as `assertNoPendingTx`, which stays as the early check.
The `anchor` kind was brought forward from phase 3 (`TxKind.Anchor`, the
check constraint, the badge, and a "moves no funds" note on the transaction
page), together with the label's home `src/lib/cardano/anchorMetadata.ts` and
`buildAnchorTx` (`anchorBuilder.ts`: `completeTreasuryTx` with no outputs).
The preprod test is a `/dev` tool, **Anchor test transaction**
(`/api/dev/anchor-test`): it builds a metadata-only transaction carrying the
test record `{v: 1, src: "treasury-guild", c: <slug>, test: 1}` under label
190002 as a pending `anchor` transaction that the signers sign and submit on
the normal transaction page. A real build against the Signius Main Treasury's
preprod UTxOs produced a 404-byte transaction; its signing is what remains.
Checked by the SQL fixture `supabase/tests/anchoring_groundwork.sql` (a
second pending row of any kind fails with 23505; submitted, confirmed and
rejected rows never block) and `src/lib/db/transactions.test.ts`.

## Phase 1: Freeze the tally document, opt-in IPFS

**Goal:** one stable document and hash per proposal that reached voting.

**The frozen document:**

- The current body without `execution`. `state`, `closedAt` and `tally` are
  final by then.
- Built once, when a proposal that reached voting arrives at a final state:
  passed, rejected, expired, or cancelled during voting.
- Stored in its own table, `proposal_tally_documents` (proposal, document,
  hash), not on the `proposals` row, so list queries stay light. Outside
  copies are recorded separately (see below). Members can read it under the same rule as the proposal; ballots are
  always visible by then.
- Written once by a governance RPC that does nothing if the row exists.

**Where it runs:**

- `advanceProposal` (`src/lib/governance/advance.ts`) right after a close.
- The cancel route, when it cancels a proposal in voting.
- The reconcile sweep, for any final proposal that reached voting and has no
  document. This covers a crash between close and freeze, and gives
  already-closed proposals their document at launch.

**Serving:** `/api/proposals/[id]/tally` returns the frozen document once it
exists, and keeps today's live behaviour before that.

**Opt-in publication, storage kept separate:**

- **The database copy is the source.** The frozen document's exact bytes
  (canonical JSON) stay in the database, and the on-chain hash proves them.
  Every outside copy is a replica that can be rebuilt from the database and
  checked against the hash, so no single store has to be relied on.
- **One interface, one adapter to start.** `src/lib/storage/` defines a
  document store (put the bytes and get a locator back, build a public URL
  from a locator, check a locator still resolves). The first adapter is IPFS
  through Pinata, server-side; `PINATA_JWT` is already read in
  `src/lib/env.server.ts`. A second store later is one more adapter.
- **Copies are recorded per document.** A table `proposal_document_copies`
  (proposal, store, locator, stored time, last checked time) holds one row
  per copy. A document can have copies in several stores, and each row keeps
  the store it was written to, so old IPFS copies keep resolving after new
  documents go somewhere else.
- **Setting.** One per-community setting, off by default, on the governance
  settings page, saved by an admin through a service-role route and logged
  with the other governance setting changes. It names the store new
  documents are published to; today the only choice is IPFS.
- **Sweep.** It publishes a frozen document that lacks a copy in the
  community's chosen store, retries failures, and periodically checks that
  existing copies still resolve, republishing from the database when one is
  gone. It never blocks the lifecycle.
- **Switching stores** changes where new documents go. Existing copies are
  left in place and never removed by a switch.
- The setting applies to proposals that close after it is turned on. Turning
  it off cannot unpublish; the confirmation says so.
- Mint images keep their own browser upload flow and are not moved onto this
  interface.

**Docs:** `governance.mdx`, `privacy.mdx` (the document holds every voter's
wallet, choice and reason).

**Built (2026-09-30).** As specified, with these particulars:

- `execution` is gone from the tally body for live and frozen documents
  alike (one shape, version stays 1; nothing had been pushed to the remote).
  `tallyDocumentText` (canonical JSON of the whole document) is the stored
  text; `parseTallyDocument` reads it back.
- `freeze_proposal_tally(p_proposal_id, p_document text, p_hash)` returns
  true when it stored the row and false when one existed; it refuses an open
  proposal and one that never reached voting (23514). Callers:
  `src/lib/governance/freeze.ts` from `advanceProposal` right after a close,
  from the cancel route when `voting_opened_at` is set, and
  `freezeMissingTallyDocuments` in the reconcile sweep (newest final
  proposals first, a page per run). All best effort.
- `proposal_tally_documents` and `proposal_document_copies` are
  member-readable; the tally route serves `document` byte for byte once it
  exists (checked locally: two downloads identical and equal to the stored
  column).
- The community-level settings got their own table,
  `governance_community_settings` (one row per community: `document_store`,
  `document_store_since`, `spend_check`), saved by
  `save_governance_community_settings` and logged in
  `governance_setting_changes` with `kind = 'community'`. The settings page's
  **Records and checks** card edits both settings; turning publication on
  opens a confirmation that names the store and says a copy cannot be taken
  back.
- `src/lib/storage/`: `DocumentStore` (`put`, `url`, `resolves`), the
  registry `documentStore(name)`, the Pinata adapter (`upload.public.file`
  of the exact bytes as `application/json`, locator = bare CID, `resolves` =
  a HEAD on the gateway) and the client-safe `locator.ts` (`copyUrl`,
  `STORE_LABELS`) that both the adapter and the proposal page use for URLs.
- `publishTallyDocuments` (`src/lib/governance/publish.ts`) runs in the
  sweep after the freeze step: up to five documents per community per run
  that were frozen since `document_store_since` and lack a copy in the
  chosen store; copies unchecked for a week are re-checked (ten per run) and
  republished from the database when gone. The proposal results show the
  frozen hash and time and link every copy.
- Not done for real: a live Pinata publish (it would put a real community's
  voter addresses on public IPFS); `src/lib/storage/ipfs.test.ts` and
  `publish.test.ts` cover the adapter and the sweep with stubs.

## Phase 2: Spend citations

**Goal:** every payout and payment record names the proposals behind it.

**Record format:**

- Payout record (still v3): optional top-level
  `g: [[proposalNumber, contentHash, [taskNumber, …]], …]`. A task number
  appears under each proposal it cites.
- Payment record (still v1): optional top-level
  `g: [[proposalNumber, contentHash], …]` for the whole record.
- `g` is omitted when nothing is cited.
- Both strict parsers rebuild their result and would drop `g`; they validate
  it and carry it through.

**Back-links (migration):**

- `tasks.proposal_id`, set by `apply_task_proposal`, kept out of the
  browser's column grants.
- `proposal_id` on `budget_setups` and `budget_plans`, stamped by a trigger
  from `treasury_guild.proposal_apply`: the applying proposal's id, or null when
  a row is written without a proposal.

**Which proposals a spend cites:**

| Spend | Cites |
|---|---|
| Task created by a task proposal | That proposal, plus the budget proposal below when there is one |
| Any task | The proposal on the plan row for its workgroup and period, else on the setup in force (`setupAt` in `src/lib/budgetSetups.ts`) |
| Manual payment with a budget period | The same lookup for the paying treasury's budget |
| Transfer between treasuries | Nothing, unless built from "Fund this budget" (phase 5) |

**Build side:**

- build-payout: load `proposal_id` with the tasks (`loadTasksForBuild`), run
  the budget lookup per task, thread through `TaskPayment` →
  `PayoutForMetadata` → `buildPayoutMetadata`.
- build-payment: run the lookup for the treasury budget; accept an optional
  `proposalId` in `buildPaymentSchema`, checked server-side as an applied
  budget proposal of the same community.
- The size guards count `g`.

**Display:** `PayoutMetadataTable`, `PaymentPreview` and
`src/lib/cardano/metadataLegend.ts` show citations; the transaction page
links each to its proposal. A spend with no citation simply shows none.

**Spending checks:**

- One pure function, `src/lib/governance/spendCheck.ts`: the lines of a spend
  (budget owner, period, asset, amount, cited proposal), the budgets in force
  and what is already spent go in; a list of problems comes out. Phase 7's
  co-signer runs the same function.
- Problems it reports:
  - no budget in force for the owner and period;
  - the spend takes the period over its budget, per asset;
  - the budget in force was not set by a proposal.
- "Already spent" uses the same payouts and payments the Dashboard counts
  (`src/lib/db/budgetDashboard.ts`), including pending transactions.
- Transfers between the community's treasuries are not spends and are not
  checked.
- Runs in build-payout and build-payment only while the community's budget
  kind is on. A new per-community setting, saved with the other governance
  settings, picks the effect: **warn** (default; problems are shown before
  signing and on the transaction page) or **refuse** (the build fails with
  the problems).

**Outside-spend alerts:**

- A transaction that spends from a treasury but was not built in the app
  lands in `external_txs`. Once the chain import has run and the row is still
  there, the sweep posts it once to the governance Discord channel
  (`governance_discord_webhooks`), recorded in a new timestamp column.
- The Treasury page marks such rows as "built outside Treasury Guild".
- Only while the budget kind is on. No wallet or name is posted, only the
  treasury, the amounts and the transaction link.

**Chain import:** an imported record's `g` is shown with the transaction.
Restoring `tasks.proposal_id` from it is out of scope.

**Tests and docs:** about six exact-shape assertions in `metadata.test.ts`,
`paymentMetadata.test.ts` and `metadataLegend.test.ts`; a SQL fixture for the
new columns and trigger; `transactions.mdx`, `payments.mdx`,
`governance.mdx`.

**Built (2026-09-30).** As specified, with these particulars:

- The budget lookup is `budgetInForce` in `src/lib/budgetSetups.ts`
  (setup in force, a recurring setup's amounts or the period's plan row; the
  plan row's `proposal_id`, else the setup's), fed by `loadBudgetSources`
  (`src/lib/db/budgetSetups.ts`). The stamping trigger
  `stamp_budget_proposal` copies `treasury_guild.proposal_apply` only when it is
  uuid-shaped, so the dry run's `'check'` and a direct save leave null, and
  a direct save of a period the vote set clears the link.
- `citationsOf` (`src/lib/governance/citations.ts`) turns the ids into
  numbered citations; `TaskPayment.citations` carries them through
  `groupByRecipient` to `PayoutForMetadata`; `buildPaymentMetadata` takes a
  citations list. `citedProposalNumbers` lets the transaction page resolve
  `#N` to the community's proposal ids (`TxPageData.citedProposals`), shown
  as a **Decisions** column in the payout table and a line in the payment
  preview (`CitationLinks`).
- `spendCheck` is pure (`src/lib/governance/spendCheck.ts`); the routes call
  `guardSpend` (`spendGuard.ts`), which loads what is spent through
  `src/lib/db/spendCheck.ts` (the Dashboard's rules plus the rows of pending
  transactions) and either returns the problems for
  `transactions.spend_problems` (warn; the transaction page shows them in a
  **Budget check** card above the signatures, never recomputed) or throws the
  build error with their texts (refuse). A task's line is its amounts times
  its assignees.
- Outside-spend alerts: `src/lib/discord/notifyOutsideSpends.ts` (pure
  message in `outsideSpendMessage.ts`) runs after the treasury sync and
  posts an `external_txs` row the import is done with (`payout_meta` null or
  `import_status` set) once, stamping `governance_alerted_at`; a row seen
  while the budget kind is off or with no webhook is stamped without a post,
  and the migration stamped every existing row. The Treasury page's badge
  reads **Built outside Treasury Guild** while the budget kind is on.
- Checked locally against the dev server: a payout of a task linked to one
  proposal under a budget stamped by another carried
  `g: [[1, …, [68]], [2, …, [68]]]` in its decoded CBOR with both links on
  the page; warn mode stored `no_budget` for a treasury without a budget and
  refuse mode answered 400 with the text; the alert posted once to a stub
  webhook. Fixture: `anchoring_groundwork.sql`; unit tests:
  `spendCheck.test.ts`, `citations.test.ts`, `budgetSetups.test.ts`
  (`budgetInForce`), `outsideSpendMessage.test.ts`, the metadata tests and
  `build-payment/route.test.ts`.

## Phase 3: Anchors

**Goal:** each proposal's content, voter list and result are on-chain, the
first of them before voting starts whenever signers act during discussion.

**Steps:**

| Step | Due from | Carries |
|---|---|---|
| Proposed | Creation | Content hash, rules hash |
| Opened | Voting opens | Electorate hash |
| Closed | Final state | Final state; for a proposal that reached voting also the tally document hash, the counts, and the CID when pinned |

- **Electorate hash:** sha256 over one line per voter, `<wallet> <0|1>` for
  recused, sorted by wallet. The format is simple enough to compute
  identically in SQL and TypeScript. `open_proposal_voting` computes it with
  the snapshot and stores it in `proposals.electorate_hash`; the verifier
  recomputes it from the tally document's electorate list.
- **Ballots sign it.** `ballotText` gains an `electorate:` line when the
  proposal has an electorate hash. Changing the voter list after the first
  ballot would invalidate every ballot already cast, so the proof no longer
  depends on when the opened anchor confirms. A proposal whose voting opened
  before the migration has no hash and keeps the old ballot text, so its
  ballots still verify. `checkTallyDocument` rebuilds whichever text applies
  and checks the hash against the electorate list.
- **Closed step when voting never opened:** a proposal withdrawn or cancelled
  during discussion gets a closed anchor only if its proposed anchor exists,
  so the chain never shows a proposal without an ending. Otherwise it is
  never anchored.
- **Closed step with publication on:** due once the document has a copy in
  the chosen store, or a day after the freeze if publishing keeps failing
  (then without a locator).
- **Locator on-chain:** the closed anchor carries the copy as a typed pair,
  store name then locator (for IPFS, the bare CID), so a later store fits
  the same record. It is a hint for finding the document without the app;
  the hash beside it is what proves the document, wherever it is fetched
  from.

**Record** (label 190002, built only in
`src/lib/cardano/anchorMetadata.ts`, with a strict parser, a legend entry and
tests): `v`, `src`, `c` (community slug) and a list of step entries, each
starting with the proposal number and the step.

**Already in place from phase 0:** `TxKind.Anchor` with its check
constraint, badge and transaction-page preview (`anchorMeta` in
`decodeTxForDisplay`); `anchorMetadata.ts` holding the label and the phase-0
test record (to be replaced by the real record and its parser); `buildAnchorTx`
in `anchorBuilder.ts`, which the `/api/tx/build-anchor` route can call as the
`/dev` tool does; the frozen document's hash in `proposal_tally_documents`
and its locators in `proposal_document_copies` for the closed step.

**Getting on-chain:**

- **Attached:** build-payout and build-payment add the label-190002 record
  with every due anchor of the community. The payout or payment record has
  priority; anchors use what room is left under the metadata guard and the
  rest stay due.
- **Dedicated:** a build route `/api/tx/build-anchor` on the existing
  `TxKind.Anchor` (the constant, check constraint, badge and preview came with
  phase 0). Treasury actors build it from the due list for a treasury they
  choose. It has no outputs.
- Mint transactions carry no anchors.
- A lock-until treasury (phase 6) cannot build anything before its date, so
  it is not offered.

**Bookkeeping:**

- A link table `proposal_anchors (proposal_id, step, transaction_id)`,
  written by a governance RPC from the build routes. A link table avoids a
  second foreign key from `proposals` to `transactions`, which breaks bare
  PostgREST embeds.
- A step is *anchored* when its transaction is confirmed, *in progress* while
  it is pending or submitted, and due again if the transaction is rejected or
  deleted. The confirm poller needs no change.
- `proposals.anchored` (boolean): the migration sets it false for proposals
  already in a final state, true otherwise and by default. Only flagged
  proposals ever appear as due.

**Pages:**

- Proposals and Treasury pages: an "anchors due" notice with a "Build anchor
  transaction" action, and a note that the next payout or payment will carry
  them anyway.
- Proposal page: each step's state, the transaction link, and the anchor's
  block time beside the time voting opened, so a late anchor is visible.
- A community with no treasury sees that anchoring needs one.

**Docs:** `governance.mdx`, `transactions.mdx`, `treasury.mdx`.

**Built (2026-09-30).** As specified, with these particulars:

- Migration `0060_anchors.sql`: `proposals.electorate_hash` (set by the
  replaced `open_proposal_voting` in the same update that opens voting, with
  the built-in `sha256(bytea)` over the `collate "C"` sorted lines; the
  no-voters cancel path sets none), `proposals.anchored` (false for every
  proposal already final), `transactions.block_time` (stamped by the confirm
  poller from Koios `tx_timestamp`, so the anchor's time can be shown beside
  the time voting opened), `proposal_anchors` (pk `(proposal_id, step,
  transaction_id)`, cascade on the transaction, member-readable through the
  proposals join) and `record_proposal_anchors(p_transaction_id, p_anchors)`
  (service role; a pending transaction only; each `{proposalId, step}` must
  be an anchored proposal of the transaction's community; returns the new
  links).
- The record: `{v:1, src, c, a}` with the entries listed under the CLAUDE.md
  invariant; `parseAnchorMetadata` is strict, `fitAnchorEntries` takes
  entries in order until the room is used up (forty proposed anchors fit
  alone, as measured). The counts are `[electorate, ballots, [[choice,
  count]…]]` so the record stays positional whatever the decision method.
- The ballot text gains `electorate: <hash>` after `rules:` only when the
  proposal has a hash; the tally body carries `proposal.electorateHash` and
  `checkTallyDocument` recomputes it from the electorate list (re-sorting in
  byte order; the document itself keeps its `localeCompare` order so frozen
  documents keep their hash). Ballots of proposals opened earlier still
  verify with the shorter text.
- The due rules are pure (`src/lib/governance/anchors.ts`) and loaded once
  (`loadDueAnchors` in `anchorsDue.ts`) for the builds, the dedicated route
  and the pages. build-payout and build-payment attach what fits after their
  own record (`attachAnchors` in `payoutBuilder.ts`) and link the carried
  steps inside `withTransactionRow`, so a failed insert links nothing;
  loading the due list is best effort there. `POST /api/tx/build-anchor`
  builds the dedicated transaction (`Anchors: proposals #1, #2`).
- Pages: the **On-chain anchors** card on the proposal page (`ProposalAnchors`,
  a row per step with the block time, the "after voting opened" mark, the
  transaction link, and **Build anchor transaction** for treasury actors while
  something is due); the **On-chain anchors due** notice on the Proposals and
  Treasury pages (`AnchorsDueNotice`, fed by `GET /api/proposals/anchors-due`);
  the transaction page's **Proposal anchors** card on any transaction that
  carries the record, with the legend. A community with no treasury reads
  that anchoring needs one.
- Checked by `supabase/tests/anchors.sql` (the migration's flag, the hash
  vector shared with `electorateHash.test.ts`, the RPC's refusals and
  cascade, RLS) and the unit tests `anchorMetadata.test.ts`,
  `anchors.test.ts`, `electorateHash.test.ts`, `ballot.test.ts`,
  `tallyDocument.test.ts` and `metadataLegend.test.ts`. Not done for real: a
  signed and confirmed anchor on preprod.

## Phase 4: Verify button and agent API

**Verify button** on the proposal page:

1. Fetch the frozen document and run `checkTallyDocument` in the browser.
2. Fetch each anchor transaction's CBOR from the chain through a new
   `/api/chain/*` route (Koios `/tx_cbor`, metadata decoded from the CBOR).
3. Compare: content and rules hashes with the proposed anchor, the recomputed
   electorate hash with the opened anchor, the document hash with the closed
   anchor.
4. Show every problem found, or that the document matches the chain, and
   whether the first two anchors confirmed before voting opened.

**Agent API:** `proposal_list` adds the content hash, rules hash, tally hash
and the anchor transaction hashes. Read-only, no new scope. Update
`src/lib/mcp/tools.test.ts` and `ai-assistants.mdx`.

**Built (2026-09-30).** As specified: **Verify record and anchors** on the
proposal page's anchors card (`VerifyRecord.tsx`) downloads the frozen
document, loads `tallyDocument.ts` by dynamic import (the module is
client-safe by construction: no `Buffer`, and core-cst already ships in a
client chunk through the wallet bridge) and runs `checkTallyDocument` in the
browser, then reads each confirmed anchor's record through the new
`GET /api/chain/tx-metadata` (Koios `/tx_cbor`, hash checked with core-cst,
record decoded from the CBOR) and compares with `compareAnchors`
(`src/lib/governance/verify.ts`, pure, tested): every mismatch is listed, or
the record is declared to match the chain, with whether the first two
anchors landed before voting opened. `proposal_list` (`V1Proposal`) carries
`contentHash`, `rulesHash`, `electorateHash`, `tallyHash` and `anchors:
{proposed, opened, closed}` (confirmed transaction hashes); the tool
description and `ai-assistants.mdx` say so, and `proposals.test.ts` pins the
shape. The tool list is unchanged. Not done for real: a Verify run against a
confirmed anchor on preprod (the comparison is unit-tested on built records).

## Phase 5: "Fund this budget" transfer prefill

- An applied budget proposal whose owner is a workgroup routed to its own
  treasury shows a "Fund this budget" action.
- It opens the Payments page with the receiving treasury and one period's
  amounts filled in through URL parameters. The admin picks the paying
  treasury and can edit the amounts.
- The built transfer cites the budget proposal through the `proposalId` field
  from phase 2.
- Not shown when the workgroup's routing is "any wallet" or the community has
  one treasury.

**Touches:** `BudgetProposalView`, the Payments page,
`src/lib/payments/form.ts`, `src/lib/routes.ts`, `payments.mdx`.

**Guidance (docs only):** `treasury.mdx` and `governance.mdx` describe the
reserve-and-operating practice: keep most funds in a reserve treasury with a
higher threshold or a wider signer set, and move only each voted budget into
operating treasuries with "Fund this budget". A spend against a vote is then
limited to one period's budget.

**Built (2026-09-30).** As specified: `fundBudgetPrefill`
(`src/lib/governance/fundBudget.ts`, pure, tested) decides per workgroup step
of a passed and applied budget proposal whether the link is offered (routing
resolves to one treasury for the funding period, at least two treasuries,
something allocated) and builds the prefill; the period is the step's own,
or the current one of a recurring step that already started, aligned to its
cadence. `BudgetProposalView` shows **Fund this budget (Oct 2026)** to admins
with the receiving treasury's name. `routes.payments(slug, prefill)` carries
`?to=&month=&proposal=&amounts=unit:display,…` (`src/lib/payments/prefill.ts`,
round-trip tested; a malformed link fills nothing). The Payments page fills
one transfer row once the treasuries load, shows a notice naming the period
and the proposal, warns when the paying treasury is the funded one, and sends
`proposalId` with the build (the route's existing check). `draftProblems`
now reports a voted amount in a token the paying treasury does not hold, which
previously had no input and was sent anyway. Docs: `payments.mdx`,
`governance.mdx` (**Funding a voted budget**, with the reserve-and-operating
practice), `treasury.mdx`.

## Phase 6: Time-lock treasury templates

**Goal:** a new treasury can be created with one of two fixed shapes.

| Template | Script | Meaning |
|---|---|---|
| Clawback | `any[ base, all[ recovery, after(slot) ] ]` | The base signers can always spend; from the date the recovery signers can too |
| Lock-until | `all[ base, after(slot) ]` | Nobody can spend before the date; the treasury can still receive |

`base` and `recovery` are each a flat all / any / atLeast group, as today.

**Schema:** template, lock slot, and the recovery group's type and threshold
on `treasuries`; a group column on `treasury_signers`; a spending path on
`transactions`. A key in both groups is refused, which keeps the signer
table's primary key.

**Decode and resolve:** `decodeTreasuryCbor` and `buildTreasuryWallet`
recognise the three shapes and nothing else. `resolveTreasury` still refuses
any disagreement between script, signers and thresholds.

**Spending paths:**

- Every transaction is built for one path and stores it.
- The base path of a clawback treasury works exactly as today.
- The recovery path is offered only from the lock date and only for payments
  (which include transfers); its purpose is moving funds out.
- A recovery-path or lock-until transaction sets `invalidBefore` to the lock
  slot, in `completeTreasuryTx` and in `mintBuilder.ts`.

**Thresholds:** `src/lib/cardano/thresholds.ts` takes the path's group, so
submit readiness, `thresholdStillReachable` and the signature display count
only that group's signatures.

**Roles:**

- Base signers keep today's behaviour: they become community admins and are
  treasury actors.
- Recovery signers are not promoted. Each must already be a member. They can
  see the treasury, and from the lock date they can build and sign
  recovery-path payments. The build, sign and reject routes check the group
  against the transaction's path.

**Creation:** the treasury form gains the template, the date and the recovery
signers. `multisigSDK.ts` builds the nested script. A confirmation step
states the date in words, what each group can do and when, and that none of
it can be changed later.

**Import:** `/api/treasury/import/preview` accepts the two shapes because it
shares the decoder; each key is matched to a signer address per group.

**Display:** treasury page, signing panel, `describeThreshold`,
`src/lib/api/v1/shape.ts`.

**Docs and tests:** `treasury.mdx`; vitest for decode, thresholds and path
selection; a preprod run of each path, including a spend refused before the
date.

**Why it is large:** `buildTreasuryWallet` runs on every treasury use, so
every build route, the treasury details read and the threshold logic change
together.

**Built (2026-10-01).** As specified, with these particulars:

- Migration `0061_treasury_templates.sql`: `treasuries.template` (`plain`,
  `clawback`, `lock_until`, `cosigner`), `lock_slot` + `lock_until` (the
  slot is the truth; the time is derived with Mesh's slot config in
  `src/lib/cardano/slots.ts`), `recovery_script_type` + `recovery_required`,
  `cosigner_kind`, all under one check constraint that ties each to its
  template; `treasury_signers.signer_group`; `transactions.spending_path`
  with the `guard_transaction_path` trigger. Existing rows are `plain`,
  `base` and on the `base` path. The fixture `supabase/tests/treasury_templates.sql`
  covers the constraints, the trigger, the decision log and RLS.
- The shapes live in the client-safe `src/lib/cardano/templates.ts`
  (`templateScript`, `shapeFromDecoded`, `shapeProblem`, `cosignerAllowed`)
  and round-trip byte for byte through core-cst and core-csl on both
  networks (`templates.test.ts`); `decodeTreasuryCbor` accepts exactly the
  four shapes and returns the `shape`; `buildTreasuryWallet` compares the
  row, the grouped signer rows and the script, and injects the stored script
  into `MultisigWallet` for every template.
- Paths: `src/lib/cardano/spendingPaths.ts` (`pathsOfTemplate`,
  `pathOffered`, `pathRule`, `describeTemplate`) and `thresholds.ts`, now
  address-based over a `SigningRule` (members + `alsoRequired`);
  `src/lib/tx.ts` resolves the path (`resolveSpendingPath`,
  `requirePathBuilder`: admins or recovery signers build recovery payments)
  and `validFromSlotFor` feeds `invalidBefore` to `completeTreasuryTx` and
  `buildMintTx` (a lock-until mint refuses a policy lock at or before the
  treasury lock). Every build schema takes an optional `path`; the sign
  route answers with `signedAddresses`, which the page's auto-submit uses.
- Creation: the form's **Template** select with the lock date
  (`datetime-local`, ≥ 1 hour ahead), the recovery signers and rule, the
  co-signer pick (a member, or Treasury Guild), and a confirmation dialog in
  plain words (`TemplateFields.tsx`); the route validates every group's
  addresses, refuses a key in two groups and a co-signer on an all-signers
  base, requires recovery signers and a member co-signer to be members, and
  promotes base signers only. Import previews the template, each group's
  rule and the lock date and matches every key per group; an imported
  co-signer is always a member.
- Display: the Treasury page badge (`describeTemplate`), the Details dialog
  (template, lock, groups), the transaction page's path line and
  per-group signatures, the Payments / Payday / Mint / anchor **Spending
  path** picker (`PathPicker`, hidden with one path, a lock notice with
  none), the Members page's `recovery signer` / `co-signer` badges, and the
  agent API's `template`, `lockUntil`, `signers[].group`, the pending
  transaction's `spendingPath` and per-path `requiredSignatures`.
- Not done for real: a templated treasury on preprod (a clawback base and
  recovery payment, a lock-until build refused before the date and accepted
  after, both with `validity_interval_start` at the lock slot).

## Phase 7: Co-signer treasury template

**Goal:** a treasury whose normal spends need one extra signature that is
given only when the spend passes the check.

**Script:** `any[ all[ base, sig(co-signer) ], all[ every base signer ] ]`.

- **Co-signed path:** the base threshold plus the co-signer.
- **Bypass path:** every base signer together, without the co-signer. It
  keeps funds reachable if the co-signer is unavailable or its key is lost.
- Refused when the base group already requires every signer, since the two
  paths would be the same.
- A third fixed template beside clawback and lock-until; the three cannot be
  combined. It reuses phase 6's decoder, path and threshold machinery.
- The co-signer key can never move funds alone. If it is stolen, the treasury
  is back at today's trust level, not below it.

**The check** (deterministic code, one home, run for every co-signed
transaction):

1. Decode the transaction's own CBOR and compare its outputs and metadata
   with the rows the app stored for it: nothing leaves the treasury except
   what those rows say, plus change back to the treasury.
2. Run `spendCheck` from phase 2 on those rows, in its strictest form: every
   problem is a refusal.
3. Confirm each cited proposal is passed and applied, and that its content
   hash matches.

| Transaction | Passes when |
|---|---|
| Payout, payment | All three steps pass |
| Transfer to a sibling treasury | Step 1 passes and the receiver is a treasury of the same community |
| Anchor | It has no outputs other than change |
| Mint | Nothing but the minted tokens leaves the treasury |

An AI agent may explain a refusal or summarise a transaction for a reviewer.
It never holds the key and never makes the pass or fail call.

**7a. A person as co-signer (first):**

- The co-signer is a member's wallet, chosen at creation, in its own signer
  group. They are not made an admin.
- The signing panel shows them the check's result and every problem before
  they sign. They sign with their wallet like any signer.
- No new key custody and no new endpoint.

**7b. The app as co-signer (second):**

- One key per treasury, generated server-side at creation, stored encrypted
  in a table with no policies; the encryption secret is a new variable read
  in `src/lib/env.server.ts`.
- Once the base threshold is reached, the server runs the check and adds its
  witness, or records the problems, which the transaction page shows. Every
  decision is logged.
- The witness is made over the core-cst transaction hash, like every other
  witness.
- The key cannot be rotated, because the script is fixed. A lost or exposed
  key means moving the funds to a new treasury through the bypass path.

**7c. A community-run co-signer (later, on request):**

- A narrow endpoint for one registered key: fetch a pending transaction with
  its records, return one witness. Not an agent API tool; that API stays
  read-only and never signs.
- The check function is published so the service can run it against the
  on-chain anchors instead of the app's database.
- Not built until a community asks for it.

**Docs and tests:** `treasury.mdx`, `governance.mdx`; vitest for the check
with matching, over-budget, uncited and tampered transactions; a preprod run
of the co-signed and bypass paths.

**Built (2026-10-01), 7a and 7b.** As specified, with these particulars:

- The `cosigner` template is the fourth shape of phase 6's `templates.ts`
  (bypass branch = `all` over exactly the base keys, in base order); its
  paths are `cosigned` (default; `pathRule` adds the co-signer as
  `alsoRequired`) and `bypass` (`all` over the base group). A rejecting
  co-signer kills a co-signed transaction, a rejecting base signer a bypass
  one.
- The check is `src/lib/cosigner/check.ts` (`runCosignerCheck`), the pure
  comparison `compare.ts` (`compareTxToRows`, tested with matching,
  over-paid, extra, missing and redirected outputs, a record naming other
  tasks, a non-sibling transfer, a swapped transfer flag, a forged asset and
  a mint carrying more than its assets). Step 2 runs only while the budget
  kind is on (decided 2026-10-01), every problem refuses, and
  `loadSpentForTargets` excludes the transaction itself; step 3 checks each
  `g` citation is passed, applied and carries the same content hash.
- 7a: the co-signer is a member's wallet in the `cosigner` group; the
  transaction page's **Co-signer check** card (`CosignerCard`, fed by
  `GET /api/tx/[txId]/cosign-check`) shows every problem above the
  signatures; they sign like any signer.
- 7b: `src/lib/cosigner/keys.ts` generates the key (csl `PrivateKey` from
  32 random bytes), stores it AES-256-GCM encrypted under
  `COSIGNER_KEY_SECRET` (required in production, `CRON_SECRET`-derived
  locally) in `treasury_cosigner_keys`, and signs the core-cst transaction
  hash into a witness set that `mergeSignerWitnesses` verifies and merges
  like a wallet's (`keys.test.ts`). `cosignWithAppKey` (`sign.ts`) runs from
  the sign route once the base rule is met, from `POST /api/tx/[txId]/cosign`
  (treasury actors, the card's **Run the co-signer check again**) and from
  the reconcile sweep (`cosignReadyTransactions`); every run is a
  `cosigner_decisions` row (trigger, passed, problems, signed) shown on the
  card. The key is never rotated; the bypass path is the recovery.
- Not done for real: a co-signed payment refused and then passed on
  preprod, and a bypass payment.
- 7c stays unbuilt until a community asks.

## Cross-cutting work

- **Migrations:** `0059_anchoring_groundwork.sql` covers phases 0 to 2
  (pending index, `anchor` kind, `spend_problems`, tally documents and
  copies, community settings, back-links and trigger, alert timestamp, RPCs);
  `0060_anchors.sql` covers phase 3 (electorate hash, `proposals.anchored`,
  `transactions.block_time`, `proposal_anchors`, `record_proposal_anchors`).
  `0061_treasury_templates.sql` covers phases 6 and 7.
- **SQL fixtures** for the new tables, trigger and RPCs; CI runs every
  `supabase/tests/*.sql`. `anchoring_groundwork.sql` covers 0059,
  `anchors.sql` 0060 and `treasury_templates.sql` 0061
  (`atomic_tx_state.sql` covers the later 0062); the `head_*` fixtures load
  them.
- **Docs:** `governance.mdx`, `transactions.mdx`, `payments.mdx`,
  `treasury.mdx`, `privacy.mdx` and `ai-assistants.mdx` are updated for
  phases 0 to 7.
- **`CLAUDE.md`** invariants are written for the pending index, `g`, the
  back-links, the spending check, the alerts, the frozen documents, the
  anchor record with its due rules, and the budget prefill; the script
  templates come with their phases.
- `scripts/recover-payout-tx.mjs` is unaffected while the payout record
  stays v3.

## Concerns and how each is handled

| Concern | Handling | What remains |
|---|---|---|
| Signing load from two or three anchors per proposal | Anchors ride on payouts and payments; dedicated transactions are batched | A quiet community still needs an occasional extra signing round |
| A pending anchor blocks payouts | Attached anchors add no pending transaction; a dedicated one can be rejected or deleted like any other | A dedicated anchor left unsigned holds the slot until someone acts |
| Anchors landing after voting began | The proposed anchor is due from creation, so it can confirm during discussion; the page shows anchor time against voting time | None for content and rules |
| The voter list is only anchored after voting opens | Every ballot signs the electorate hash | The window between voting opening and the first ballot, when no vote exists to be affected |
| Two builds racing past the pending check | Unique index in phase 0 | None |
| IPFS publication is irreversible | Off by default, admin only, confirmation text, logged | A pinned document stays public |
| Depending on one storage provider | The database copy and the on-chain hash are the source; outside copies are replicas behind one interface, checked and republished by the sweep | If the app's database is lost too, a document survives only where a copy still resolves or a member kept the download |
| Time locks are permanent | Two fixed templates, a confirmation step in plain words, existing treasuries untouched | A wrong date or recovery group needs a new treasury |
| A payout that fit before might not fit with anchors | The payout record has priority; anchors only use spare room | None |
| Spends against a vote | Citations and anchors make them provable; the app warns or refuses; outside spends are announced; reserve and operating treasuries cap the amount; a co-signer treasury refuses them unless every signer acts together | Unanimous signers can still bypass, and the check is enforced by the app or the co-signer, not the chain. Only a contract with on-chain voting removes that |
| A server-held co-signer key | It can never spend alone; one key per treasury, encrypted; a person can be the co-signer instead | The app operator is trusted not to co-sign wrongly |
| A refusing check blocks legitimate work | Warn is the default; refuse is a community's choice; the bypass path exists on co-signer treasuries | A budget set before proposals were on must be re-voted before refuse mode passes it |

## Out of scope

- Enforcing votes on-chain, and any smart contract.
- Ballots or voter lists on-chain.
- Anchoring proposals that were already closed at launch.
- Anchoring what a passed proposal did when applied; spend citations cover
  its effects.
- Rebuilding proposal links from chain data in the chain import.
- Arbitrary nested treasury scripts, combining templates, and adding a time
  lock or a co-signer to an existing treasury.
- Snapshotting the voter list at creation; it would change who may vote.
- An AI agent that decides whether to co-sign.
- The community-run co-signer (7c) until a community asks for it.

## Order

1. Phase 0: groundwork. Done (signing of the preprod test pending).
2. Phase 1: freeze the tally document, opt-in IPFS. Done.
3. Phase 2: spend citations. Done.
4. Phase 3: anchors. Done (a confirmed preprod anchor pending).
5. Phase 4: verify button and agent API. Done.
6. Phase 5: transfer prefill. Done.
7. Phase 6: time-lock templates. Done (preprod runs pending).
8. Phase 7: co-signer template, 7a then 7b. Done (preprod runs pending; 7c by request).
