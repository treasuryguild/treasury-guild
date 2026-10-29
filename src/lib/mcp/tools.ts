// The MCP tool registry: the single source of truth for what an AI client can
// do through /api/mcp. Each tool is an agent API endpoint (src/lib/api/v1),
// the same one its /api/v1 route serves, so authorization and validation are
// written once.
//
// Tool results carry text other people wrote (task titles, workgroup and
// treasury names, transaction descriptions), which reaches the model; a tool
// that could sign, pay or change data next to that would turn prompt injection
// into a way to move funds. So almost every tool reads. The writes all go
// through a human confirmation step (multisig's preview -> token -> propose):
// a `*_preview` tool runs the app's own checks, writes nothing and returns a
// draft token, and only proposal_create (for proposal_preview) or
// draft_confirm (for every other preview) carries a token out, after the user
// agreed. Each write needs a write scope the user ticks separately
// (proposals:write, tasks:write, payouts:write, governance:write). A payout or
// Cardano governance draft only creates the pending transaction: the
// treasury's signers sign it in the app. src/lib/mcp/tools.test.ts pins the
// list and the two writing tools; a new write is a deliberate decision with
// its own scope, never a quiet addition. No tool signs, submits or casts a
// community proposal ballot.
import "server-only";

import { endpointAllowed, type ApiEndpoint } from "@/lib/api/v1/endpoint";
import { budgetSummary } from "@/lib/api/v1/budgets";
import { previewCallCreate, previewCallFinalize } from "@/lib/api/v1/callWrite";
import { listCalls } from "@/lib/api/v1/calls";
import { listCommunities, whoami } from "@/lib/api/v1/communities";
import { confirmDraft } from "@/lib/api/v1/drafts";
import { fundingSummary } from "@/lib/api/v1/funding";
import { previewDrep, previewStake, previewVote } from "@/lib/api/v1/governanceWrite";
import { listIncoming } from "@/lib/api/v1/incoming";
import { listMembers } from "@/lib/api/v1/members";
import { previewPayout } from "@/lib/api/v1/payoutWrite";
import { listProposals, proposalDetail } from "@/lib/api/v1/proposals";
import { previewProposalWithdraw } from "@/lib/api/v1/proposalWithdraw";
import { createProposalFromDraft, previewProposal } from "@/lib/api/v1/proposalWrite";
import { signingQueue } from "@/lib/api/v1/signing";
import { listTasks } from "@/lib/api/v1/tasks";
import { previewTaskSave } from "@/lib/api/v1/taskWrite";
import { listTransactions, transactionDetail } from "@/lib/api/v1/transactions";
import { treasuryOverview } from "@/lib/api/v1/treasuries";
import { listWorkgroups } from "@/lib/api/v1/workgroups";
import type { ApiScope } from "./scopes";

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  endpoint: ApiEndpoint;
  /** The /api/v1 route serving the same endpoint (documentation, tests). */
  restPath: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
/** Reads the Cardano chain as well as Treasury Guild's own records. */
const READ_ONLY_CHAIN = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;
/** Creates a record; replaying the same input answers with the first result. */
const CREATES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** A write preview: checks and shows, changes nothing; a fresh draft token each call. */
const PREVIEWS = { readOnlyHint: true, idempotentHint: false, openWorldHint: false } as const;
/**
 * draft_confirm: carries out a previewed write. A withdrawn proposal cannot be
 * reopened (destructive), and a payout reads the chain (open world).
 */
const CONFIRMS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

export const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: "guild_whoami",
    title: "Who am I",
    description: "The wallet this connection acts for, and the permissions it was granted.",
    endpoint: whoami,
    restPath: "/api/v1/me",
    annotations: READ_ONLY,
  },
  {
    name: "community_list",
    title: "My communities",
    description:
      "The Treasury Guild communities the wallet belongs to, with its role in each (owner, admin or member), the Cardano network and a link. Other tools take a community's `slug`.",
    endpoint: listCommunities,
    restPath: "/api/v1/communities",
    annotations: READ_ONLY,
  },
  {
    name: "treasury_overview",
    title: "Treasury overview",
    description:
      "A community's multisig treasuries: address, template (plain, clawback, lock_until or cosigner) with its lock date, signing rule and signers with their group (base, recovery, cosigner), whether it is archived, current balance (ADA and tokens, read from the chain) and the pending transaction waiting for signatures, if any, with its spending path. Pass balances: false to skip the chain read.",
    endpoint: treasuryOverview,
    restPath: "/api/v1/communities/{community}/treasuries",
    annotations: READ_ONLY_CHAIN,
  },
  {
    name: "task_list",
    title: "Tasks",
    description:
      "A community's tasks, newest first: workgroup, board column, reward per assignee, assignees, payment state and whether each can be paid right now (readyToPay). Filter by workgroup name, payState (payable = approved and waiting for a payout) or limit. payableCount is the community-wide number of payable tasks.",
    endpoint: listTasks,
    restPath: "/api/v1/communities/{community}/tasks",
    annotations: READ_ONLY,
  },
  {
    name: "budget_summary",
    title: "Budget summary",
    description:
      "Budget against spending per workgroup and treasury for a month (default: this month), a quarter, or the recurring plan, with per-token totals and the most recent spending.",
    endpoint: budgetSummary,
    restPath: "/api/v1/communities/{community}/budgets",
    annotations: READ_ONLY,
  },
  {
    name: "proposal_list",
    title: "Proposals",
    description:
      "A community's proposals, newest first: decisions, budget changes, new workgroups and tasks put to a vote. For each: what passing it changes, how it is decided and who votes, turnout, deadlines, the result once voting closed, whether it was carried out, the caller's own vote (canVote: they may vote now), and its on-chain evidence: the content, rules and voter-list fingerprints every ballot signs, the frozen tally's hash, and the transaction hashes of its confirmed anchors (label 190002). Voting itself needs a wallet signature in the app (url). Filter state: open, closed or all.",
    endpoint: listProposals,
    restPath: "/api/v1/communities/{community}/proposals",
    annotations: READ_ONLY,
  },
  {
    name: "signing_queue",
    title: "Waiting for my signature",
    description:
      "Pending transactions, across all the wallet's communities, whose signing rule includes this wallet: kind, description, spending path, signatures so far against those needed, whether this wallet already signed or rejected it, and whether it is ready to submit. waitingOnMe counts those it has neither signed nor rejected. Signing happens in the app (url).",
    endpoint: signingQueue,
    restPath: "/api/v1/me/signing-queue",
    annotations: READ_ONLY,
  },
  {
    name: "transaction_list",
    title: "Transactions",
    description:
      "A community's transactions, newest first: payouts of task rewards, manual payments and transfers, mints and proposal anchors, with their treasury, state (pending, submitted, confirmed, rejected), on-chain hash, signatures, when they were submitted and confirmed, and any budget problems found when they were built. Filter by treasury name, kind, state or limit.",
    endpoint: listTransactions,
    restPath: "/api/v1/communities/{community}/transactions",
    annotations: READ_ONLY,
  },
  {
    name: "workgroup_list",
    title: "Workgroups",
    description:
      "A community's workgroups: description, whether tasks come from GitHub or are made in the app, the treasury that pays it this period (null = any), its leads and a link to its board. task_list takes these names as its workgroup filter.",
    endpoint: listWorkgroups,
    restPath: "/api/v1/communities/{community}/workgroups",
    annotations: READ_ONLY,
  },
  {
    name: "incoming_list",
    title: "Incoming funds",
    description:
      "What arrived in a community's treasuries, newest first: amount in ADA and tokens, the receiving treasury, the sending treasury for a transfer between the community's own treasuries, its type (contribution, revenue, refund, transfer, other or unclassified) and whether it waits for an admin's review.",
    endpoint: listIncoming,
    restPath: "/api/v1/communities/{community}/incoming",
    annotations: READ_ONLY,
  },
  {
    name: "member_list",
    title: "Members",
    description:
      "A community's members: name (handle or GitHub login), role (owner, admin or member), wallet address, GitHub login and the workgroups each leads. Use it to find who someone is, or the leads of a workgroup proposal.",
    endpoint: listMembers,
    restPath: "/api/v1/communities/{community}/members",
    annotations: READ_ONLY,
  },
  {
    name: "transaction_detail",
    title: "Transaction detail",
    description:
      "One transaction, by its id or on-chain hash: state, who has signed and who still needs to (on its own spending path), whether it is ready to submit, every payout line (task, recipient, token, amount), payment lines (transfers between the community's treasuries flagged), minted tokens, the fee, the Treasury Guild record it carries on chain (decoded from its own CBOR), budget problems found when it was built and the co-signer's decisions. Use it to check what a transaction pays before signing it in the app.",
    endpoint: transactionDetail,
    restPath: "/api/v1/communities/{community}/transactions/{tx}",
    annotations: READ_ONLY,
  },
  {
    name: "funding_summary",
    title: "Funding sources",
    description:
      "A community's outside funders and what each committed (a one-off total, a recurring amount, or a schedule), against what has arrived in the inflows tied to them: planned, due so far, received, difference and remaining per token, with the latest periods of recurring commitments.",
    endpoint: fundingSummary,
    restPath: "/api/v1/communities/{community}/funding",
    annotations: READ_ONLY,
  },
  {
    name: "call_list",
    title: "Calls",
    description:
      "A community's rewarded calls, newest first: workgroup, platform, times, the reward each qualifying attendee gets, the attendance threshold, whether attendance was paid (finalized), and attendees by standing (rewarded, ready, without a wallet, below the threshold, excluded). Give a call's id for its attendee list. Filter state: open or finalized.",
    endpoint: listCalls,
    restPath: "/api/v1/communities/{community}/calls",
    annotations: READ_ONLY,
  },
  {
    name: "proposal_detail",
    title: "Proposal detail",
    description:
      "One proposal by number, with what proposal_list shows plus its full text, its timeline (created, voting opened, closed, carried out, withdrawn or cancelled, and by whom), the voter count, every ballot with its reason once ballots are visible (never while a vote with hidden results runs), the frozen tally's hash and copies, and what carrying it out made.",
    endpoint: proposalDetail,
    restPath: "/api/v1/communities/{community}/proposals/{proposal}",
    annotations: READ_ONLY,
  },
  {
    name: "proposal_preview",
    title: "Preview a proposal",
    description:
      "Check a proposal the user wants to make and show what it would be, without creating anything: a decision (a question put to a vote), a task with a bounty on an app board only (not a GitHub board; those keep using issues), a new workgroup (leads named as member_list shows them), or budget changes (per workgroup or treasury: recurring from a month, or one month or quarter; needs budget consent on). Optional rules override the community's defaults for this proposal only, and are fixed once it is created. On a task, only an admin or a lead of that workgroup can set rules; anyone else must omit them. Returns what passing it changes, who votes and how it is decided, when voting would open and close, what creating it does, and a draftToken valid for 15 minutes. Refused when nobody could vote, with the reason and nothing created. Show the preview to the user; only if they agree, call proposal_create with the token.",
    endpoint: previewProposal,
    restPath: "/api/v1/communities/{community}/proposals/preview",
    // Writes nothing; a fresh token each call. A budget proposal reads the paying treasury's tokens from the chain.
    annotations: { ...PREVIEWS, openWorldHint: true },
  },
  {
    name: "proposal_create",
    title: "Create a previewed proposal",
    description:
      "Create the proposal a proposal_preview described, in the user's name, from its draftToken only. Call it only after the user confirmed that preview. Refused when the community's rules or anything the proposal depends on changed since (preview again). Safe to retry: the same token always answers with the one proposal it created (created: false on a repeat). Members then vote in the app (url); nothing changes unless it passes.",
    endpoint: createProposalFromDraft,
    restPath: "/api/v1/communities/{community}/proposals/create",
    annotations: CREATES,
  },
  {
    name: "proposal_withdraw_preview",
    title: "Preview withdrawing a proposal",
    description:
      "Check that the user can withdraw one of their own proposals (only while it is in discussion) and show what that does, without doing it. Returns a draftToken for draft_confirm.",
    endpoint: previewProposalWithdraw,
    restPath: "/api/v1/communities/{community}/proposals/withdraw/preview",
    annotations: PREVIEWS,
  },
  {
    name: "task_preview",
    title: "Preview a task change",
    description:
      "Create a task on an app board (give workgroup and title) or edit one (give its task number) the user manages: title, description, reward per assignee, budget month. Shows the change, before and after, without making it. A new task starts in the board's first column, not payable; an edit is refused once a task is payable, queued or paid, and never moves it. Returns a draftToken for draft_confirm.",
    endpoint: previewTaskSave,
    restPath: "/api/v1/communities/{community}/tasks/preview",
    annotations: PREVIEWS,
  },
  {
    name: "call_create_preview",
    title: "Preview a rewarded call",
    description:
      "Plan a rewarded call in a workgroup the user manages: platform (discord, zoom, meet or manual check-in), title, start and end, the reward each qualifying attendee gets, and the channel, meeting id or Meet code attendance is read from. Checks it as the Calls page does, without creating it. Returns a draftToken for draft_confirm.",
    endpoint: previewCallCreate,
    restPath: "/api/v1/communities/{community}/calls/preview",
    annotations: PREVIEWS,
  },
  {
    name: "call_finalize_preview",
    title: "Preview paying a call's attendance",
    description:
      "Show who a call's finalize would pay (attendees who qualify and have a linked wallet), the reward each and the attendance tasks it would create, without doing it. The tasks are created payable, ready for the next payout. Returns a draftToken for draft_confirm.",
    endpoint: previewCallFinalize,
    restPath: "/api/v1/communities/{community}/calls/finalize/preview",
    annotations: PREVIEWS,
  },
  {
    name: "payout_preview",
    title: "Preview a payout",
    description:
      "Prepare a payout of tasks ready to pay (the task numbers given, or every ready task, optionally of one workgroup) from the treasury they are routed to, running every check of the app's Payday page, without creating anything. Shows each recipient and amount, the totals, the signatures needed and any budget problems. Confirming (draft_confirm) only creates the pending transaction: the treasury's signers still sign it in the app, and nothing is paid until they do.",
    endpoint: previewPayout,
    restPath: "/api/v1/communities/{community}/payouts/preview",
    // Reads the treasury from the chain to build the transaction it shows.
    annotations: { ...PREVIEWS, openWorldHint: true },
  },
  {
    name: "stake_preview",
    title: "Preview a stake transaction",
    description:
      "Prepare a stake register, register-and-delegate, delegate, deregister, withdraw or vote-delegation transaction for a plain SDK treasury the user signs for, running the same checks as the Staking page, without creating anything. Confirming (draft_confirm) only creates the pending transaction: signers still sign in the app with payment and stake keys. Not a community proposal ballot.",
    endpoint: previewStake,
    restPath: "/api/v1/communities/{community}/governance/stake/preview",
    annotations: { ...PREVIEWS, openWorldHint: true },
  },
  {
    name: "drep_preview",
    title: "Preview a DRep transaction",
    description:
      "Prepare a Cardano DRep register, update or retire transaction for a plain SDK treasury the user signs for, without creating anything. Metadata is pinned for register/update. Confirming (draft_confirm) only creates the pending transaction; signers still sign in the app. Separate from community proposals.",
    endpoint: previewDrep,
    restPath: "/api/v1/communities/{community}/governance/drep/preview",
    annotations: { ...PREVIEWS, openWorldHint: true },
  },
  {
    name: "vote_preview",
    title: "Preview an on-chain governance vote",
    description:
      "Prepare an on-chain Cardano governance vote as the treasury's script DRep (one or more proposal votes, optional CIP-100 rationale), without creating anything. The DRep must already be registered. Confirming (draft_confirm) only creates the pending transaction; signers still sign in the app. Cannot cast community proposal ballots.",
    endpoint: previewVote,
    restPath: "/api/v1/communities/{community}/governance/vote/preview",
    annotations: { ...PREVIEWS, openWorldHint: true },
  },
  {
    name: "draft_confirm",
    title: "Carry out a previewed change",
    description:
      "Carry out what a *_preview tool (other than proposal_preview, which proposal_create confirms) showed, from its draftToken only: withdraw the proposal, save the task, create the call, pay the call's attendance into tasks, create the payout's pending transaction, or create a stake / DRep / on-chain vote pending transaction. Call it only after the user explicitly agreed to that preview. Refused when anything changed since the preview (preview again). Safe to retry: a repeated token answers with what the first one did (created: false). Never signs, submits or casts a community proposal ballot.",
    endpoint: confirmDraft,
    restPath: "/api/v1/drafts/confirm",
    annotations: CONFIRMS,
  },
];

/** The tools a caller with these scopes may use: tools/list never offers one that would answer 403. */
export function toolsForScopes(scopes: readonly ApiScope[]): McpToolDef[] {
  return MCP_TOOLS.filter((tool) => endpointAllowed(tool.endpoint, scopes));
}
