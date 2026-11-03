# Recognition module

*Status: multiphase plan. Phases 0–4 are the MVP ship line; 5–7 are
post-pilot. Implementation follows this doc; user-facing docs land in
Phase 4 (`src/content/docs/recognition.mdx`).*

## Problem

Communities want a way to recognise higher-quality work without turning
tokens into membership, roles, or spending authority. Activity-based XP
(points per paid task) rewards volume, not craft. Recognition should be a
**human judgment** attached to **already-paid work**, scored in seasons,
with an optional on-chain souvenir later — never a gate on Payday or
signing.

## Non-goals / deny-list

Recognition **must never**:

- change `tasks` amounts or `pay_state`, or write `payouts` / `payments`
- participate in budgets or `spendCheck` / `guardSpend`
- alter who may sign a treasury path, or co-signer checks
- auto-grant admin, owner, or workgroup lead
- mint on every endorsement, or run a transferable REP faucet that claims
  treasury funds
- replace wallet membership, invites, or primary-treasury signer → admin

Disable stops **new** writes and hides UI; event history is kept.

## Product shape

Opt-in per community, same spirit as governance: a missing
`recognition_settings` row means **off** (defaults live in
`src/lib/recognition/`). Admins turn it on under
`/c/[slug]/settings/recognition` and tune a small set of knobs (or apply
a Quiet / Standard / Loud preset).

### Event model

Table `recognition_events` (member-readable, service-role writes):

| Column | Notes |
|--------|--------|
| `kind` | MVP: `endorsement`. Later: `peer_kudos`, `steward`, `season_award` |
| `subject_wallet` | Who is recognised |
| `actor_wallet` | Who granted it |
| `task_id` | Required for endorsement / peer_kudos |
| `workgroup_id` | From the task |
| `weight` | Usually 1; score multiplies by kind |
| `note` | Optional, ≤500 chars |
| `season_key` | `YYYY-MM` or `YYYY-Qn` from settings cadence |
| `revoked_at` / `revoke_reason` | Soft revoke only |

**MVP eligibility**

- Module enabled
- Task `pay_state` in `paid` | `reconciled`
- Subject is an assignee (wallet) on that task
- Actor ≠ subject; actor is admin or lead of the task’s workgroup
- No `call_tasks` row for the task (attendance tasks ineligible)
- One active endorsement per `(task_id, subject_wallet)`
- Actor under `max_endorsements_per_actor_season` for the season

**Revoke:** admin or original actor.

### Settings (MVP)

| Column | Default when on |
|--------|-----------------|
| `enabled` | false (no row ⇒ off) |
| `season` | `quarter` |
| `max_endorsements_per_actor_season` | 10 |
| `show_leaderboard` | false |

Presets (client-side blobs applied on save):

- **Quiet** — quarter, max 5, no leaderboard
- **Standard** — quarter, max 10, no leaderboard
- **Loud** — month, max 20, leaderboard on

Post-MVP settings (Phase 5+): `peer_kudos_enabled`,
`min_member_days_to_kudos`, `electorate_endorsed`.

### Scoring (pure)

MVP: `seasonScore = 3 * active_endorsements` (ADA paid never counted).

Tiers: Noted 1–2, Craft 3–5, Exemplar 6+.

Phase 5 adds `+ 0.25 * peer_kudos` (after caps) and reciprocal dampening.

### Soft privileges / mint (later)

- Phase 6: optional governance electorate `endorsed` (snapshot wallets;
  still one member, one vote)
- Phase 7: admin batch season-badge NFT mint via existing mint path

## Phases

| Phase | Deliverable | Gate |
|-------|-------------|------|
| 0 | This design doc + OVERVIEW pointer | Scope agreed |
| 1 | Migration, RPCs, `src/lib/recognition/`, db helpers, SQL fixture | Unit + SQL tests |
| 2 | Settings / endorse / revoke / list APIs + route tests | API tests |
| 3 | Settings UI, TaskModal endorse, `/recognition` page | Manual §B–D |
| 4 | User MDX, privacy, OVERVIEW, CLAUDE | docs.test |
| 5 | Peer kudos | Pilot wants it |
| 6 | Electorate `endorsed` | Pilot wants it |
| 7 | Season badge mint | Pilot wants it |

## MVP acceptance checklist

### A. Module hygiene

- [ ] Off by default; enable/disable in one admin place
- [ ] Disable hides UI and refuses writes; history kept
- [ ] Config never writes tasks/payouts/budgets/membership roles

### B. Core loop

- [ ] Lead/admin endorses paid assignee from TaskModal
- [ ] Refuses unpaid, self, non-assignee, call tasks, over cap
- [ ] Remaining endorsements visible; subject sees event same day
- [ ] Revoke with reason; score drops

### C. Anti-farming

- [ ] Cap enforced; unique active endorsement per task+subject
- [ ] Rate limit allows a normal Payday batch of endorsements

### D. Config

- [ ] Season month↔quarter does not rewrite past `season_key` rows
- [ ] Cap change applies to new grants; presets understandable

### E. Success signals (pilot ~30 days)

- [ ] Scarcity: not every paid task endorsed
- [ ] ≥3 different actors endorse; ≥5 distinct subjects
- [ ] No “endorse to get paid” pressure

### F. Hard fail

- [ ] Any payout/sign/budget coupling → abort
- [ ] Cannot turn off cleanly → abort

### G. Out of MVP

No REP FT faucet, no auto-mint per endorsement, no auto role grant,
no public cross-community leaderboard.

## File map

| Home | Path |
|------|------|
| Pure logic | `src/lib/recognition/` |
| DB | `src/lib/db/recognition.ts`, types in `src/lib/db/types.ts` |
| Constants | `src/lib/constants.ts` (`RecognitionKind`, rate limits) |
| API | `src/app/api/recognition/*` |
| Settings UI | `src/app/c/[slug]/settings/recognition/` |
| Season UI | `src/app/c/[slug]/recognition/` |
| Endorse UI | `src/components/board/TaskModal.tsx` (+ recognition components) |
| Hooks | `src/hooks/useRecognition*.ts` |
| Routes | `src/lib/routes.ts` |
| User docs | `src/content/docs/recognition.mdx` |
| Migration | `supabase/migrations/0092_recognition.sql` (+ later 0093+ if split) |
| SQL tests | `supabase/tests/recognition.sql` |

## Pointer

See also `docs/OVERVIEW.md` (optional recognition module under adjacent
ideas / product surface once Phase 4 lands).
