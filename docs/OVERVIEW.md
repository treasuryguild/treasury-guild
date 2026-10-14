# Guild Vault — product overview

*Written for agents and collaborators who need to understand what this product is before proposing ideas around it. It describes the essence, not the implementation. End-user documentation lives in the app at `/docs` (source: `src/content/docs/*.mdx`).*

## One sentence

Guild Vault is a treasury manager for Cardano communities: a shared multisig wallet, a task board of bounty work, and a "Payday" flow that pays contributors in one batch transaction with a verifiable on-chain record of who was paid for what.

## The problem it solves

Community-run organisations on Cardano (DAOs, guilds, working groups, open-source collectives) hold funds in a shared wallet and pay contributors for completed work. Today that usually means:

- tracking tasks and bounties in GitHub or a spreadsheet,
- a treasurer hand-building payments one at a time,
- signers coordinating over chat,
- and no durable, public link between a payment and the work it paid for.

Guild Vault collapses that into one place, so a community can go from "this task is done" to "this contributor has been paid, and anyone can verify it on-chain" without leaving the app.

## Core concepts

**Community** — the top-level organisation. Has members, admins, one or more treasuries, and workgroups. Users sign in with their Cardano wallet only (no email/password). Each community runs on mainnet or preprod, chosen at creation and never changed, so one deployment hosts both and every treasury matches its community's network. Roles: owner, admins, members, and **workgroup leads** who manage their workgroup's board and can build payouts for it; a treasury's base signers are made admins. Communities are private by default; public communities allow self-joining, and GitHub assignments, call check-in and linked Discord capture can also add members.

**Treasury** — a native-script multisig wallet owned by the community. Signers are ordinary CIP-30 browser wallets. Any signer can add a partial signature; the app collects them and submits once the threshold is met. Nothing moves without the required signers. An existing multisig can be imported from its native-script CBOR, keeping its signer order. A new treasury picks one of four fixed **templates**, written into the script for good: plain multisig; **clawback** (from a lock date a second group of recovery signers can move the funds out too); **lock-until** (nothing can be spent before the date, receiving continues); or **co-signer** (a normal spend needs the base rule plus a co-signer, which is either a chosen member or Guild Vault itself holding one encrypted key per treasury, and every base signer together can still spend without it). Every transaction is built for one **spending path** (base, recovery, co-signed or bypass), and only that path's signers count. A treasury has at most one transaction waiting for signatures at a time (a second would spend the same coins); rejecting or deleting it puts its tasks back to payable in the same step.

**Workgroup** — a sub-team inside the community (e.g. "Marketing", "Dev"). Each workgroup has a task board, an optional budget, and can be routed to a specific treasury.

**Task** — a unit of paid work. It carries a bounty (in ADA and/or native tokens), one or more assignees, and a lifecycle: not yet payable → payable → queued → paid → reconciled (`none`, `payable`, `queued`, `paid`, `reconciled` in the data). Tasks come from two sources:
- **Native boards** — a kanban inside the app; dragging a card into the payable column makes it eligible.
- **GitHub** — issues from a repo or Projects v2 board, imported by a GitHub App. An issue becomes payable when it has the payable label and status column. Assignees mirror the GitHub assignee list; contributors link their GitHub username to their wallet.

**Calls** — attendance rewards. A call (Discord, Zoom, Meet, anything) has a reward per attendee and an attendee list, filled by a wallet check-in code shared during the call, by adding members, or by pasting names that are matched to members. Finalizing turns eligible attendees with a wallet into ordinary native tasks (at most 20 assignees each), so they are paid on Payday like any other task. Contributors can link a Discord and a Google account on their profile. A community can connect its Discord server: while a Discord call runs, a cron takes a snapshot of its voice channel every 5 minutes over a short-lived gateway connection (no always-on bot), and attendees seen in enough snapshots qualify. A community can also connect the Zoom account that hosts its calls: join and leave webhooks give live presence, the participant report read after the meeting repairs it, and minutes are the union of sessions inside the call window. Google Meet works the same way without webhooks: the account that creates the meetings is connected (scope `meetings.space.readonly`), and the cron polls the conference record while a call runs and once after it ends; signed-in participants are matched exactly through their linked Google account. A recurring Zoom or Meet meeting can be **linked** to a workgroup with a title, reward, threshold and usual length: each occurrence then creates its own call (on the first Zoom join, or when the cron finds a new Meet conference) and the call's end follows the meeting. Zoom events of a connected account that match no call are parked until the cleanup job removes events older than 24 hours, keeping participant names, identifiers and times but no emails or raw payloads. Managers see only meeting summaries as **detected meetings**, so a call created after the meeting started still gets its attendance. An attendance task takes the budget period of the call's date; once a call has attendance tasks its reward is locked and it cannot be deleted, so a call is never paid twice. The bot leaves on its own any Discord server it was added to whose connection was never completed.

**Payday** — the treasurer's view. Select payable tasks, and the app builds a single transaction with one output per contributor wallet, paying every assignee the task's full bounty. Tokens are discovered from whatever the treasury holds and matched to bounty fields by ticker.

**Payments** — the same multisig flow for money that is not a task bounty: paying another community or a contractor, paying a member outside any workgroup budget, or moving funds between the community's own treasuries. Each treasury has its own budget for these payments; a transfer to a sibling treasury is neither income nor spending.

**On-chain record** — every payout transaction carries structured metadata (label 190001) listing, per output, the task numbers, workgroup, budget period (month or quarter) and amounts. A manual payment writes a distinct record under the same label (`t: "payment"`): the budget period, an optional memo and, per output, the amounts and a flag telling spending (0) from a transfer to a sibling treasury (1); a pure transfer has an empty period. Both records cite the decisions behind them (`g`: the proposal that created a task, the budget proposal that set the period's budget). Proposal anchors ride under label 190002 (see Proposals & voting) and mints carry CIP-25 (label 721). The transaction page shows each record raw with a legend of its keys. This makes the treasury's spending publicly auditable straight from the chain, without trusting the app's database.

**Reconciliation** — the app polls the chain (every 15 minutes, and on opening the Treasury or Incoming page when the last check is older than two minutes) to confirm submitted payouts, marks tasks paid, comments the tx hash back onto GitHub issues, posts a payout summary to the treasury's Discord channel when a webhook is configured, and records every inflow so admins can classify it (contribution, revenue, other, refund) and treasury signers can match a refund to the payout it returns. The same sweep repairs a task left queued with no live payout.

**Chain import** — the on-chain record is complete enough to rebuild the database from. When a treasury's outgoing transaction carries a Guild Vault record the app has no row for (built by another deployment, or lost), the app reads the transaction's own bytes and recreates the payout or payment as confirmed history, creating missing tasks as paid stubs titled `Imported task #N` that can be retitled. A transaction is imported completely or not at all; anything ambiguous (an unknown workgroup name, a task number already used by a different task) waits in a queue on the Treasury page for an admin to resolve. Imported history keeps its block time and is never announced on Discord.

**Funding sources** — outside funders (a grant treasury releasing a monthly allocation, Project Catalyst proposals, a sponsor) and their commitments: one-off totals, recurring amounts, or schedules loaded from a funder's release-plan CSV. Admins tie treasury inflows to a source (and commitment) on the Incoming page; the Funding page shows planned, due so far, received, over/under and still to receive, per token and per period, and the Dashboard's funding flow names the source.

**Previous-wallet history** — a community that moved from an ordinary wallet can carry that wallet's payments over from a CSV it exported and audited itself (`userId` = the receiver's address end, one column per token ticker, `task`, `date`, `workgroup`). The old wallet is never read on-chain. The lines are their own records (not tasks, payouts or transactions), count as the workgroup's spend and budget use in the period of their date, and show on the Dashboard as paid from "*name* (previous wallet)", tasks and contributors included. Re-importing a file skips lines already there; admins can replace or delete imports and single lines.

**Budgets** — allocations by month or quarter, per token, with full change history: one per workgroup for its task payouts and one per treasury for its manual payments. Payouts and payments are attributed to a budget month, giving a spend-vs-plan view over time. A budget can be backfilled for the periods before its first setup (with a reason), so earlier spending has a plan to be compared with.

**Proposals & voting** — a community can decide by vote: free-text decisions (polls) and, with **budget consent** on, budget changes, which the Budgets page turns into one proposal that applies itself (through save_budget_setup) when it passes; direct budget saves and resets are then refused in the database. Admins set per kind who proposes, who votes (all members, admins, admins + leads, the people of the workgroups concerned, or recently paid contributors, with a minimum membership age), the method (consent with blocks, majority with quorum and threshold, or lazy consensus), discussion and voting periods, hidden-until-close results and recusal. Rules are frozen and hashed onto each proposal, the electorate is snapshotted when voting opens (one member, one vote), and every ballot is a CIP-30 signature over a server-built text, stored for anyone to verify. New workgroups can likewise be decided by vote (they are then created as app boards with the proposed leads, and admins stop creating them directly), and members can propose tasks with a bounty on app boards, decided by lazy consensus up to a cap and by majority or consent above it. Proposals can be announced on a Discord channel (discussion, voting open, a day left, the result), read (and, once the user confirms a preview, made or withdrawn) by AI assistants, and every closed vote downloads as a hashed, signed tally that anyone can re-verify. Once a proposal that reached a vote is final its tally is frozen (stored once with its hash, optionally published to IPFS), and each proposal's fingerprints go on the Cardano chain as **anchors** (metadata label 190002: content and rules hashes when proposed, the voter-list hash when voting opens, which every ballot also signs, and the result with the frozen tally's hash when closed), riding on the community's next payout or payment or on a dedicated fee-only transaction; a Verify button recomputes the checks in the browser and compares the record with the chain. Every payout and payment cites the decisions behind it on-chain, is checked against the voted budgets while budget consent is on (warn, the default, or refuse; a transaction built outside the app is marked and announced once), and an applied budget proposal offers **Fund this budget**, a prefilled transfer to the workgroup's treasury that cites it. A **co-signer treasury** ties spending to votes more tightly: its co-signer signs only what passes a check that the transaction's bytes match the rows it was built from, the strict budget check and every cited decision; this is near-enforcement, since the bypass path (every base signer) still exists and the chain does not run the check.

**Dashboard** — the community's read-only money view for a month, a quarter or all time: budget vs spending per workgroup and treasury, contributors and tasks paid, treasury spending over time and the funding flow below, ordered by the community's main spending token.

**Funding flow** — a community with several treasuries (a main wallet funding per-workgroup wallets, some also funded from outside) sees income → wallets → workgroups as one diagram: transfers between its own wallets are recognised on-chain and never counted as income or spending, and a workgroup's wallet changes are dated to budget periods so its spending history stays whole.

**Minting** — a treasury can mint its own native tokens (with optional time-lock), authorised by the same multisig, with images on IPFS. Minted tokens are then usable as bounty currency like any other.

## A typical loop

1. A contributor picks up a GitHub issue with a bounty.
2. They finish the work; a maintainer moves it to "In review" with the payable label.
3. The task appears as payable in Guild Vault, attached to the contributor's linked wallet.
4. A treasurer opens Payday, selects this month's payable tasks, and builds one transaction.
5. Signers each approve from their own wallet; the last signature triggers submission.
6. The chain confirms it. Tasks flip to paid, the GitHub issue gets a "paid" label and the tx hash, and moves to the board's Paid status.
7. Anyone can read the tx metadata and see exactly which tasks that payment covered.

## What makes it distinctive

- **Wallet-native identity.** No accounts, no passwords. Your wallet is your login and your payout address.
- **Trust-minimised treasury.** Funds sit in a native-script multisig; the app never holds a key that can spend alone (the optional app-held co-signer key only completes the base signers' rule, and every base signer together can bypass it).
- **Work → payment → proof, end to end.** The link between a task and its payment is written to the chain, not just the database.
- **Meets contributors where they already work.** GitHub issues and Projects boards are first-class; the app follows them rather than replacing them.
- **Batch by default.** One transaction per pay run, however many contributors and tokens.
- **Audit-first data model.** Archives, resets and deletions are guarded and leave immutable event records.
- **Privacy by design.** Only what a flow needs is stored (the privacy policy at `/docs/privacy` is the contract); linked platform account ids are never shown to other members, and abuse-prone actions are rate limited.
- **Usable by AI assistants.** A remote MCP server (`/api/mcp`, OAuth sign-in with the wallet, no keys to paste) lets Claude and other assistants read communities, treasuries, workgroups, members, tasks, budgets, proposals, transactions and the signing queue, incoming payments, funding and calls; the same tools are a small REST API (`/api/v1`). With a write permission the user ticked, an assistant can also make or withdraw proposals, create and edit tasks, create calls and pay their attendance, and prepare payout transactions, each only after showing a preview the user confirms. Nothing an assistant does can sign, submit or vote: a prepared payout still waits for the treasury's signers.

## Who it is for

- Cardano DAOs, Catalyst-funded projects, and open-source collectives paying contributors from a shared wallet.
- Working-group leads who need a budget and board for their team.
- Contributors who want to see what is payable, when they were paid, and prove it.
- Anyone auditing a community's spending from public chain data.

## Stack, briefly

Next.js (App Router) · MeshJS for Cardano transactions · Koios as the chain data provider · Supabase (Postgres with row-level security) · GitHub App for sync · Netlify with scheduled functions for chain polling, GitHub sync repair and call attendance capture.

An internal `/dev` tools page, gated by the `DEV_WALLETS` allowlist, hosts testers for the team: a "run now" trigger for the reconcile, GitHub-sync and call-capture jobs (the scheduled jobs never reach a local stack), the Discord message tester and an anchor test transaction.

## Not in scope today

Fiat, payroll or tax handling; non-Cardano chains; on-chain voting (proposals are decided by off-chain signed ballots and only their fingerprints are anchored, see Proposals & voting); on-chain enforcement of budgets (the co-signer is near-enforcement, and a community-run co-signer service is not built); escrow or milestone-based release; contributor reputation. These are natural adjacent areas for ideas.
