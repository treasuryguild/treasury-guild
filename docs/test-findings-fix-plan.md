# Fix plan: findings from the 2026-10-01 test sweep

*Status: every item below was implemented on 2026-10-01 (migration
`0062_atomic_tx_state.sql`, fixture `supabase/tests/atomic_tx_state.sql`),
verified on the local stack; verification steps 4 to 6 (the browser
walk-through, the preprod co-signer run and `db push`) are still open. Three
details differ from the text: Koios' `_after_block_height` is inclusive, so
the cursor stops at the undescribed block rather than one below it,
`pay_tasks_for_tx` takes no transaction id, and the sweep repair is the SQL
function `release_orphaned_queued_tasks()` behind the
`releaseOrphanedQueuedTasks()` wrapper. The sections describe the
behaviour before the fix.*

## Summary

| # | Finding | Where | Risk | Fix shape |
|---|---|---|---|---|
| 1 | Confirmation is not atomic: the tx flips to Confirmed before its payouts and tasks are updated, so a failure in between is never retried | `src/lib/reconciliation/poll.ts:99-131` | Tasks stay unpaid after a real payment; Payday would offer them again (blocked only by `tasksWithLivePayouts`) and the board never moves them to Paid | One `confirm_transaction` RPC (migration 0062) |
| 2 | The sync cursor advances past a hash Koios listed but did not describe, so a transient gap becomes a permanently missing inflow or outside-spend row | `poll.ts:139-143, 185` | Silent loss of an inflow (funding, refunds) or of an outside spend that should be announced | Cap the cursor below the first undescribed hash |
| 3 | When the app co-signer's check passes but the witness step throws, no `cosigner_decisions` row is written; the sweep retries every 15 minutes with no trace members can see | `src/lib/cosigner/sign.ts:63-76` | A treasury looks stuck with no explanation on the transaction page | Record a decision on the failure, then rethrow |
| 4 | Reject and delete release queued tasks in a second write after the state change, with no compensation | `src/app/api/tx/[txId]/reject/route.ts:38-43`, `src/app/api/tx/[txId]/route.ts` | A rejected or deleted transaction can leave tasks `queued` forever (the browser may only move `none` ↔ `payable`) | Two RPCs in migration 0062 plus one idempotent sweep repair |
| 5a | A manual token connection typed in another case is upserted beside the auto row (`community_assets` pk is case-sensitive) | `src/app/api/tx/build-payout/route.ts:119-140, 251` | Two registry rows for one field; display picks the later one | Canonicalise the field name before the upsert |
| 5b | A `payments` row with a null `budget_month` would throw in the spent loader; only the SQL range keeps transfers out | `src/lib/db/spendCheck.ts:47, 134` | A future query change would crash the spend check | Type the row nullable and skip nulls |
| 5c | An admin removing themselves gets "You cannot change your own role" | `src/app/api/members/route.ts:23-25, 67` | Wording only | Separate message for DELETE |

Order of work: 3, 4, 1, 2, 5. Items 1 and 4 share migration 0062 and one
SQL fixture; do them together. Items 3 and 2 are independent and small.

## Conventions that apply

- Multi-table state changes go through an RPC (`import_chain_tx`,
  `finalize_call`, `add_signature`, `record_proposal_anchors` are the
  precedents); the route or poller calls it through `rpc` in
  `src/lib/db/client.ts`, never a sequence of `update` calls.
- A new migration is `supabase/migrations/0062_<name>.sql`, applied locally
  with `.\scripts\supa.ps1 migration up --local` (never `db:reset` unasked),
  with a fixture `supabase/tests/<name>.sql` that CI and
  `.\scripts\seed-tests.ps1` run.
- Row shapes in `src/lib/db/types.ts`, helpers in `src/lib/db/*.ts`, docs in
  the same change (`CLAUDE.md`, `src/content/docs/*.mdx`).
- No commits: leave the working tree for the maintainer.

---

## 1. Atomic confirmation (`confirm_transaction`)

### Today

`pollTreasury` confirms a submitted transaction in four writes, in this order:

1. `transactions.state = 2, block_time = …` (`poll.ts:103-109`)
2. `payouts.status = confirmed` where `submitted` (`:110-117`)
3. read the payout task ids (`:118-124`)
4. `markTasksPaid(taskIds, txHash)` (`src/lib/db/tasks.ts:95-140`): `pay_state = paid`,
   `paid_tx_hash`, and native tasks moved to the `marks_paid` column

The poller selects only `state = Submitted` (`:90-97`), so once write 1 lands
nothing revisits writes 2 to 4. `poll.test.ts` pins this with
"throws when a confirmation write fails" (first write only).

### Fix

**Migration `0062_atomic_tx_state.sql`**, part one: an RPC

```sql
create or replace function confirm_transaction(
  p_transaction_id uuid, p_block_time timestamptz
) returns boolean
```

- `security definer`, `revoke execute … from anon, authenticated` (the
  pattern in 0046 / 0053), service role only.
- `select … for update` the transaction; return `false` unless
  `state = 1` (submitted). This is the idempotency guard: a retry after a
  crash finds `state = 2` and returns `false`; a first run does everything.
- In one statement block: set `state = 2`, `block_time`; update the payouts
  rows to `confirmed` where `submitted`; for each distinct task of those
  payouts set `pay_state = 'paid'`, `paid_tx_hash = transactions.tx_hash`
  and, for native tasks, `column_id` to the workgroup's `marks_paid` column
  when one exists. Reuse the SQL `import_chain_tx` already has for this
  (`0045_chain_import.sql:143-159`); do not write it a third time (extract
  a private helper `pay_tasks_for_tx(p_tx uuid, p_tx_hash text, p_task_ids uuid[])`
  and call it from both).
- `guard_task_lifecycle` and `guard_task_client_write` must let the RPC's
  writes through as the service role, as they do for `markTasksPaid` today;
  the fixture proves it.

**Code**

- `src/lib/db/transactions.ts`: `confirmTransaction(id, blockTime): Promise<boolean>`
  wrapping `rpc("confirm_transaction", …)`.
- `poll.ts`: replace the four writes with one call; count `confirmed` only
  on `true`. Everything after (Discord announcement, GitHub write-back) keeps
  reading `state = 2` and `discord_notified_at`, unchanged.
- `markTasksPaid` in `src/lib/db/tasks.ts`: check its other callers
  (`scripts/recover-payout-tx.mjs` has its own SQL; grep `markTasksPaid`
  under `src/`). If the poller was the only caller, delete it and its
  `board_columns` lookups; otherwise leave it.

### Tests

- New fixture `supabase/tests/atomic_tx_state.sql` (shared with item 4):
  a submitted payout with two tasks (one native with a Paid column, one
  GitHub); `confirm_transaction` returns `true` once, flips the tx, the
  payouts and both tasks, moves only the native one; a second call returns
  `false` and changes nothing; a pending or rejected tx returns `false`;
  `authenticated` cannot execute it.
- `poll.test.ts`: replace the four-write expectations in "confirms a
  submitted payout…" and the payment / mint / anchor cases with one
  `confirmTransaction(id, blockTime)` call per hash found; replace "throws
  when a confirmation write fails" with "a false return is not counted and
  nothing else is written"; keep the `markTasksPaid` mock out entirely.
- `src/lib/db/transactions.test.ts`: one case for the new wrapper's
  `rpc` mapping, like the existing `addSignature` case.

### Docs

- `CLAUDE.md` payout-metadata bullet: "`tasks.paid_tx_hash` is written by
  the confirm poller and by `import_chain_tx`" → "by the
  `confirm_transaction` RPC (poller) and by `import_chain_tx`".
- `README.md` cron bullet and `src/content/docs/reconciliation.mdx` need no
  change (the behaviour they describe is what the RPC guarantees).

---

## 2. The cursor must not pass an undescribed hash

### Today

`poll.ts:139-143`: `maxBlock` takes every listed `block_height` before the
`if (!info) continue` skip, and `upsertCursor(db, treasury.id, maxBlock)` at
`:185` stores it. `addressTxs` asks Koios for `_after_block_height = cursor`
(`src/lib/cardano/koios.ts:83-90`), so a hash whose `tx_info` was missing in
this run (Koios lag, a partial bulk answer) is never listed again.
`poll.test.ts` "resumes from the stored height…" pins the advance.

The confirmation loop has the same dependency on `infoByHash` but is safe:
an unconfirmed tx stays `Submitted` and is retried.

### Fix

In `poll.ts`, after building `infoByHash`:

```ts
const undescribed = txs.filter((t) => !infoByHash.has(t.tx_hash));
```

- Advance `maxBlock` only over described hashes.
- If `undescribed` is not empty, cap the cursor: `Math.min(maxBlock,
  Math.min(...undescribed.map((t) => t.block_height)) - 1)`, never below the
  previous `cursor`, and `console.warn` the hashes once. Re-listed rows
  already inserted hit the unique violation that the inflow and external
  inserts tolerate (`:158`, `:176`), so the next poll only fills the gap.
- Check the Koios semantics of `_after_block_height` (inclusive or
  exclusive) against the live API before choosing `- 1`; write the answer
  in the comment.
- Add the `console.error` the `incoming_txs` insert lacks for a non-unique
  error (`:176`), mirroring `:158-160`. The poll test's re-poll case keeps
  passing; add one case for a logged insert error.

### Tests

- `poll.test.ts`: change "resumes from the stored height…" so an undescribed
  hash holds the cursor at its block minus one, and add "advances past it
  once described on the next poll" (two polls, second `txInfoBulk` answer
  complete). Keep the case where every hash is described advancing to the
  maximum.

### Docs

None: the reconciliation guide does not describe the cursor.

---

## 3. Record a decision when the co-signer cannot sign

### Today

`cosignWithAppKey` (`sign.ts:63-76`): after `runCosignerCheck` passes, the
seed is decrypted, the witness built and merged, and `addSignature` called.
`InvariantError` ("witness does not verify", "address does not match its
key") or any throw from `decryptSeed` / `witnessSetHex` /
`mergeSignerWitnesses` leaves the function before
`insertCosignerDecision` (`:77`). The sweep's `catch` logs it
(`:107-108`) and, because the latest decision is still unsigned, retries
every run. `sign.test.ts` pins "recording no decision".

### Fix

- Wrap the signing block in `try … catch`. On a throw, write
  `insertCosignerDecision({ transactionId, trigger, passed: true, problems:
  [\`Signing failed: ${errorMessage(err)}\`], signed: false })` and rethrow.
  The `cosigner_decisions` check constraint (0061: a witness is only added
  after a pass) allows `passed = true, signed = false`.
- The sweep keeps retrying (a decrypt failure may be a missing
  `COSIGNER_KEY_SECRET` that an operator fixes), but the transaction page
  now shows the reason in the **Co-signer check** card's decision list.
  Cap the noise: in `cosignReadyTransactions`, skip a transaction whose
  latest decision is a signing failure less than an hour old (the sweep
  runs every 15 minutes; four attempts an hour is plenty). Use
  `decided_at` and the `Signing failed:` prefix, or, cleaner, add a
  nullable `error` column to `cosigner_decisions` in migration 0062 and
  test on that instead of parsing text. Prefer the column: it keeps
  `problems` for check problems only, which `CosignerCard` renders as such.

### Tests

- `sign.test.ts`: the three "recording no decision" cases become "records a
  signing-failure decision and rethrows" (assert the row's fields and that
  `addSignature` was not called). Add the sweep case "skips a transaction
  whose latest decision is a recent signing failure" and "retries one older
  than an hour".
- If the column is added: `supabase/tests/atomic_tx_state.sql` (or the
  existing `treasury_templates.sql`) asserts the constraint still refuses
  `signed = true` with `passed = false`, and accepts `error` only with
  `signed = false`.

### Docs

- `src/content/docs/transactions.mdx`, "The co-signer check": after "on a
  refusal it records why", add that a failure to sign after a pass is
  recorded too, and that the background job retries it.
- `CLAUDE.md` templates bullet: "records every run in `cosigner_decisions`"
  → "records every run, signing failures included, in
  `cosigner_decisions`".
- `src/content/docs/privacy.mdx` needs no change (still no person named).

---

## 4. Reject and delete release tasks atomically

### Today

- Reject: `recordRejection` (guarded conditional update,
  `src/lib/db/transactions.ts:126-146`) then, when dead,
  `releaseQueuedTasks(txId)` (`src/lib/db/tasks.ts:12-16`: read payout task
  ids, set `queued → payable`). A failure in the second call leaves a
  `Rejected` transaction with `queued` tasks.
- Delete: `payoutTaskIds` → `deletePendingTransaction` (payouts cascade)
  → `releaseTasks(ids)`. A failure in the last call leaves `queued` tasks
  with no payouts row at all.
- Nothing repairs either: `guard_task_client_write` (0046) lets the
  browser move `pay_state` only between `none` and `payable`, the task
  editor refuses settled tasks, and Payday lists payable tasks only. The
  sweep has no step for it.
- `reject/route.test.ts` pins the order `recordRejection` then
  `releaseQueuedTasks`; `[txId]/route.test.ts` pins `payoutTaskIds` →
  `deletePendingTransaction` → `releaseTasks`.

### Fix

**Migration `0062_atomic_tx_state.sql`**, part two: two RPCs, service role
only like `add_signature`.

```sql
create or replace function reject_transaction(
  p_transaction_id uuid, p_expected_signed text[], p_expected_rejected text[],
  p_rejected text[], p_dead boolean
) returns boolean
```

- Same guard as `recordRejection` (state pending, both lists equal to what
  the route read), returns `false` on a mismatch. When `p_dead`, also sets
  `state = 3` and releases the payout tasks (`pay_state = 'payable'` where
  `queued`) in the same transaction. The reachability decision stays in
  TypeScript (`thresholdStillReachable`), as today.

```sql
create or replace function delete_pending_transaction(p_transaction_id uuid)
returns boolean
```

- Lock the row; return `false` unless pending; release its payout tasks;
  delete the row (payouts and `proposal_anchors` cascade as today).

**Code**

- `recordRejection` and `deletePendingTransaction` in
  `src/lib/db/transactions.ts` become thin `rpc` wrappers with the same
  signatures and boolean contract, so the routes change only by dropping
  the second call. `releaseQueuedTasks` loses its last caller: delete it
  (`payoutTaskIds` and `releaseTasks` stay if anything else uses them; grep).
- **Sweep repair**, belt and braces for rows already orphaned:
  `releaseOrphanedQueuedTasks()` in `src/lib/db/tasks.ts`, run once per
  reconcile sweep (`sweep.ts`, next to `purgeRateLimits`): set `payable` on
  tasks that are `queued` and have no payouts row in a transaction with
  `state in (0, 1, 2)`. Idempotent, one statement, logged with the count.
  Register nothing new in `src/lib/cron/jobs.ts`; it is part of the
  existing reconcile job's description ("repairs …"): update that text.

### Tests

- Fixture `supabase/tests/atomic_tx_state.sql`: `reject_transaction`
  returns `false` on a stale list or a non-pending tx and changes nothing;
  a live rejection records the list; a dead one flips the state and
  releases exactly that transaction's queued tasks, leaving a task queued
  in another pending tx alone; `delete_pending_transaction` releases then
  deletes, returns `false` for a submitted tx; `authenticated` cannot
  execute either.
- `reject/route.test.ts`: drop the `releaseQueuedTasks` mock and the
  ordering assertions; assert `recordRejection` is called with `dead`.
  `[txId]/route.test.ts`: drop `payoutTaskIds` / `releaseTasks`; assert one
  `deletePendingTransaction` call and the 409 on `false`.
- `src/lib/db/transactions.test.ts`: the two wrappers' `rpc` mapping.
- `sweep.test.ts`: the repair step runs and its count is reported.

### Docs

- `CLAUDE.md`: the "Signature appends use the `add_signature` RPC …
  Rejections are guarded the same way" bullet names `reject_transaction`
  and `delete_pending_transaction`, and the reconcile sweep list gains the
  orphan repair.
- `src/content/docs/transactions.mdx` "Deleting" and "Signing → Reject":
  no wording change (tasks "become payable again" already).

---

## 5. Minor

### 5a. Manual token connections keyed in another case

`build-payout/route.ts:119-140` matches the request's field
case-insensitively against `fieldNames` but stores `fieldName: field` as
typed; `upsertAssetMappings` (`:251`) upserts on `(community_id,
field_name)`, which is case-sensitive (`0009_multi_asset.sql:12`).

Fix: resolve the canonical name once, `const canonical = fieldNames.find((f)
=> f.toLowerCase() === lower)`, and use it in `def` (`:133`) and in the
problem texts. No migration; a one-off cleanup of duplicate rows on the
remote can wait for `db:snapshot` evidence that any exist.

Tests: `build-payout/route.test.ts` "token connections" case: the manual
def carries the batch's casing (`GVTT`), and `upsertAssetMappings` gets one
row per field. `src/lib/tokenMatch.test.ts` unchanged.

### 5b. Null `budget_month` in the spent loader

`spendCheck.ts:47` types the payments row as `budget_month: string` while
`PaymentRow.budget_month` is `string | null` (`types.ts:234`); `:134` calls
`.slice` on it. The `gte / lt` filters (`:96-97`) keep transfers out today.

Fix: type it `string | null` and `continue` on null with a comment that
transfers carry no period. Test: `db/spendCheck.test.ts` feeds one null-month
row and expects it ignored.

### 5c. Self-removal wording

`guardTarget` (`members/route.ts:23-25`) is shared by PATCH and DELETE.
Fix: give it a `verb` parameter ("change your own role" / "remove
yourself"), or check `target === session.wallet` in DELETE before calling
it with "You cannot remove yourself". Test: `members/route.test.ts` DELETE
self case asserts the new text.

---

## Verification, in order

1. `.\scripts\supa.ps1 migration up --local` for 0062 on the running local
   stack (ask before any reset: local-only preprod history exists).
2. `.\scripts\seed-tests.ps1 -Filter atomic_tx_state`, then the whole
   fixture set (`-Port 45432` if 54330 is blocked).
3. `npx vitest run`, `npm run typecheck`, `npm run lint`.
4. `npm run seed:live` on the local stack, build a payout, sign, submit,
   run the reconcile job from `/dev`: the tx confirms in one step; reject
   a second build and check its tasks return to payable; delete a third.
5. A co-signer treasury on preprod with `COSIGNER_KEY_SECRET` briefly
   wrong: the transaction page shows the signing-failure decision.
6. `.\scripts\supa.ps1 db push --dry-run`, then `db push` when the
   maintainer decides.
