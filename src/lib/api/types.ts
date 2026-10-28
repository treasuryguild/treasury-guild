import type { BudgetOwnerType, BudgetSetupContext } from "@/lib/budgetSetups";
// Response (wire) types shared by API routes and the client hooks that call
// them. Client-safe: types only.

import type { NativeScript } from "@meshsdk/core";
import type { WalletToken } from "@/lib/cardano/assetInfo";
import type { ScriptType } from "@/lib/cardano/types";
import type { Network } from "@/lib/config";
import type { CallsSyncResult } from "@/lib/calls/capture";
import type { DetectedMeeting } from "@/lib/calls/zoomSessions";
import type { CronJobId } from "@/lib/cron/jobs";
import type { GithubSyncSweepResult } from "@/lib/github/sweep";
import type { ChainImportRunResult } from "@/lib/chainImport/run";
import type { AnchorStep, CosignerKind, SignerGroup, SpendingPath, TreasuryTemplate } from "@/lib/constants";
import type { ChainSyncResult } from "@/lib/reconciliation/staleSync";
import type { ReconcileSweepResult } from "@/lib/reconciliation/sweep";
import type { CallMeetingLinkRow, CallRow, CommunityRow, CosignerDecisionRow, TaskAssigneeRow, TreasuryRow } from "@/lib/db/types";
import type { FlowMonth } from "@/lib/fundingFlow";
import type { GovernanceCommunitySettings } from "@/lib/governance/rules";
import type { MatchSuggestion } from "@/lib/reconciliation/types";
import type { LiveBoardResponse } from "@/lib/boardTypes";
import type { LegacyImportPlan, LegacyToken, LegacyTotal } from "@/lib/legacyHistory/types";

export interface ApiErrorBody {
  error: string;
  /** Per-item validation problems (build-payout). */
  problems?: string[];
  /** Optimistic-concurrency conflict: the client should refetch. */
  conflict?: boolean;
}

export interface TreasuryImportPreview {
  address: string;
  scriptCbor: string;
  /** plain, clawback, lock_until or cosigner, as read from the script. */
  template: TreasuryTemplate;
  /** The base group's rule. */
  scriptType: ScriptType;
  required: number;
  /** The recovery group's rule of a clawback script. */
  recovery: { scriptType: ScriptType; required: number } | null;
  lockSlot: number | null;
  /** The lock slot as a time on the community's network. */
  lockUntil: string | null;
  /** Every key in script order, with the wallet found for it ("" when unknown) and its group. */
  signers: { keyHash: string; address: string; group: SignerGroup }[];
}

export interface OkResponse {
  ok: true;
}

// --- Auth ---------------------------------------------------------------------

export interface SessionTokenResponse {
  token: string | null;
  wallet: string | null;
  /** The wallet is on the DEV_WALLETS allowlist (shows the /dev tools page). */
  developer: boolean;
}
export interface AuthNonceResponse {
  nonce: string;
}
export interface AuthVerifyResponse {
  wallet: string;
  firstLogin: boolean;
}

// --- Chain --------------------------------------------------------------------

export interface WalletTokenWire {
  unit: string;
  /** On-chain integer as a decimal string. */
  quantity: string;
  ticker: string | null;
  name: string | null;
  decimals: number;
  source: WalletToken["source"];
}
export interface WalletAssetsResponse {
  lovelace: string;
  utxoCount: number;
  tokens: WalletTokenWire[];
}
export interface TxStatusResponse {
  onChain: boolean;
  blockHeight: number | null;
}
/** GET /api/chain/tx-metadata: a transaction's label-190002 record, decoded from its own CBOR. */
export interface TxMetadataResponse {
  onChain: boolean;
  /** When the chain included it (ISO), once on-chain. */
  blockTime: string | null;
  /** The decoded label-190002 value, or null when the transaction carries none (or its CBOR does not hash to the id). */
  anchor: unknown;
}

// --- Community ----------------------------------------------------------------

export interface CreateCommunityResponse {
  community: CommunityRow;
}
export interface JoinCommunityResponse extends OkResponse {
  slug: string;
}
/** The routing assignment made for a treasury linked to a workgroup at creation. */
export interface TreasuryWorkgroupLink {
  workgroupId: string;
  /** First day of the budget period the link starts in. */
  startsOn: string;
  /** "next" when this period was already paid from another wallet. */
  effective: "current" | "next";
}
export interface CreateTreasuryResponse {
  treasury: TreasuryRow;
  /** Null for a community treasury, or when the link could not be made. */
  link: TreasuryWorkgroupLink | null;
  /** Why a requested link was not made; the treasury exists regardless. */
  linkError: string | null;
}
/** One signer of a treasury, in the order they appear in the native script. */
export interface TreasuryDetailsSigner {
  walletAddress: string;
  /** Payment key hash (the `sig` leaf in the native script). */
  keyHash: string;
  displayName: string | null;
  /** base, recovery or cosigner. */
  group: SignerGroup;
}
/** Everything the treasury details dialog shows, re-derived from the DB rows. */
export interface TreasuryDetails {
  id: string;
  name: string;
  network: Network;
  address: string;
  /** The base group's rule. */
  scriptType: ScriptType;
  required: number;
  template: TreasuryTemplate;
  lockSlot: number | null;
  lockUntil: string | null;
  /** The recovery group's rule of a clawback treasury. */
  recovery: { scriptType: ScriptType; required: number } | null;
  /** The co-signer of a cosigner treasury: who holds the key and its address. */
  cosigner: { kind: CosignerKind; keyHash: string; walletAddress: string } | null;
  /** Payment native script as JSON (CIP-1854 key order). */
  nativeScript: NativeScript;
  /** Hex CBOR of the payment native script (what tx inputs are witnessed with). */
  scriptCbor: string;
  /** Hash of the payment script: also the policy id of unlocked mints. */
  scriptHash: string;
  stakeCredentialHash: string | null;
  stakeAddress: string | null;
  signers: TreasuryDetailsSigner[];
}
export interface TreasuryDetailsResponse {
  treasury: TreasuryDetails;
}
/** A treasury's Discord connection as admins see it: never the URL itself. */
/** A connected Discord webhook, without its secret URL. */
export interface DiscordWebhookStatus {
  /** `…/webhooks/<id>/••••<last 4 chars of the token>`. */
  urlHint: string;
  lastPostedAt: string | null;
  lastError: string | null;
}
export interface TreasuryDiscordWebhookStatus extends DiscordWebhookStatus {
  treasuryId: string;
}
export interface TreasuryDiscordWebhooksResponse {
  /** One entry per treasury of the community that has a webhook. */
  webhooks: TreasuryDiscordWebhookStatus[];
}
export interface SetTreasuryDiscordWebhookResponse {
  webhook: TreasuryDiscordWebhookStatus;
}

// --- Tasks --------------------------------------------------------------------

export interface TaskAssigneesResponse {
  assignees: TaskAssigneeRow[];
}

// --- Calls --------------------------------------------------------------------

export interface CallResponse {
  call: CallRow;
}
export interface MeetingLinkResponse {
  link: CallMeetingLinkRow;
}
/** GET /api/calls/detected: meetings of the connected Zoom account that no call covers yet. */
export interface DetectedMeetingsResponse {
  meetings: DetectedMeeting[];
}
export interface AddAttendeesResponse {
  added: number;
  /** Of the added names, how many were matched to a member's wallet. */
  matched: number;
  /** Already on the list (same name or same wallet). */
  skipped: number;
}
export interface CheckinCodeResponse {
  /** Null until a manager creates one. */
  code: string | null;
}
export interface CallCheckinResponse {
  title: string;
  communitySlug: string;
  /** The wallet was on the list before this check-in. */
  already: boolean;
}
/** GET /api/calls/discord-channels: what a Discord call can be captured from. */
export interface DiscordChannelsResponse {
  /** The community connected a Discord server and the bot is still in it. */
  connected: boolean;
  serverName: string | null;
  channels: { id: string; name: string }[];
}
export interface CaptureCallResponse {
  /** People in the voice channel right now. */
  present: number;
  /** Of them, new to the call's list. */
  added: number;
}
export interface FinalizeCallResponse {
  taskIds: string[];
  /** Attendees placed on the new tasks. */
  paid: number;
  /** Attendees still without a task. */
  remaining: number;
}

// --- Transactions -------------------------------------------------------------

export interface BuildTxResponse {
  txId: string;
  txHash: string;
}
export interface BuildPayoutResponse extends BuildTxResponse {
  totalByUnit: Record<string, string>;
  outputs: { address: string; assets: { unit: string; quantity: string }[] }[];
}
/** POST /api/tx/build-payment: same shape as a payout build. */
export type BuildPaymentResponse = BuildPayoutResponse;
export interface BuildMintResponse extends BuildTxResponse {
  policyId: string;
  lockSlot: number | null;
  lockUntil: string | null;
  units: string[];
}
/** POST /api/tx/build-anchor: a metadata-only transaction carrying the community's due anchors. */
export interface BuildAnchorResponse extends BuildTxResponse {
  /** The proposals anchored, by number. */
  proposals: number[];
  /** Due steps that did not fit and stay due. */
  remaining: number;
}
/** GET /api/proposals/anchors-due: the steps a payout, payment or anchor transaction would carry. */
export interface AnchorsDueResponse {
  due: { proposalId: string; number: number; steps: AnchorStep[] }[];
}
export interface SignTxResponse {
  signedCount: number;
  /** Who has signed after this signature landed, the app co-signer included when it signed too. */
  signedAddresses: string[];
}
/** GET /api/tx/[txId]/cosign-check: the co-signer check run now, and every decision so far. */
export interface CosignCheckResponse {
  passed: boolean;
  problems: string[];
  /** Newest first; only an app-held co-signer records decisions. */
  decisions: CosignerDecisionRow[];
}
/** POST /api/tx/[txId]/cosign: the app-held co-signer re-ran its check. */
export interface CosignResponse {
  signed: boolean;
  passed: boolean;
  problems: string[];
  signedAddresses: string[];
}
export interface SubmitTxResponse {
  txHash: string;
}
export interface RejectTxResponse {
  rejected: true;
  dead: boolean;
}
export interface DeleteTxResponse {
  deleted: true;
}

// --- Reconciliation -----------------------------------------------------------

export interface MatchSuggestionsResponse {
  suggestions: MatchSuggestion[];
}

/**
 * POST /api/chain-import/workgroup and /api/chain-import/resolve: what the
 * action imported, and what is still held with its reasons.
 */
export type ChainImportRunResponse = ChainImportRunResult;

/** POST /api/treasury/sync: on-visit chain poll of treasuries not checked recently. */
export type ChainSyncResponse = ChainSyncResult;

export interface BudgetSummary {
  id: string;
  budgetMonth: string | null;
  /** A workgroup's budget, or a treasury's budget for manual payments. */
  ownerType: BudgetOwnerType;
  ownerId: string;
  /** Display name; treasuries read "Treasury: <name>". */
  ownerName: string;
  /** Set for a treasury owner. */
  treasuryId: string | null;
  /** Set for a workgroup owner. */
  workgroupKind: string | null;
  cadence: "monthly" | "quarterly";
  unit: string;
  assetLabel: string;
  decimals: number;
  amount: string;
  spent: string;
  balance: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
}

export interface BudgetTotal {
  unit: string;
  amount: string;
  spent: string;
  balance: string;
}

/** One spend line: a task payout charged to a workgroup, or a manual payment charged to a treasury. */
export interface BudgetSpendingItem {
  id: string;
  /** `legacy`: a line imported from a previous wallet's CSV (no transaction). */
  kind: "payout" | "payment" | "legacy";
  ownerType: BudgetOwnerType;
  ownerId: string;
  ownerName: string;
  /** The task title, or the payment's recipient label / short address. */
  title: string;
  unit: string;
  amount: string;
  status: string;
  createdAt: string;
}

export interface BudgetIncomingItem {
  txHash: string;
  treasuryName: string;
  /** The community treasury it came from, for an internal transfer. */
  fromTreasuryName: string | null;
  amountLovelace: string;
  assets: Record<string, string> | null;
  blockTime: string | null;
  incomingType: string;
  requiresReconciliation: boolean;
  matched: boolean;
}

/** A reconciled refund, attributed to the workgroup whose payout it returned. */
/** A reconciled refund, netted from the workgroup that was paid. */
export interface BudgetRefundItem {
  ownerId: string;
  unit: string;
  amount: string;
  createdAt: string;
}

/** GET /api/budgets: the worksheet's plan for a period with what was spent. */
export interface BudgetsResponse {
  setups: BudgetSetupContext[];
  budgets: BudgetSummary[];
  totals: BudgetTotal[];
  spending: BudgetSpendingItem[];
  refunds: BudgetRefundItem[];
}

// --- Dashboard ----------------------------------------------------------------

/** Net spending (payouts minus reconciled refunds) in base units. */
export interface DashboardSpendingCell {
  treasuryId: string;
  unit: string;
  amount: string;
}
/** A budget owner's month: a workgroup's payouts, or a treasury's manual payments (no tasks). */
export interface DashboardOwnerMonth {
  ownerType: BudgetOwnerType;
  ownerId: string;
  contributors: number;
  tasks: number;
  spending: DashboardSpendingCell[];
}
/** One calendar month by budget period (`spendingMonth`); counts are distinct across owners. */
export interface DashboardMonth {
  month: string;
  contributors: number;
  tasks: number;
  byOwner: DashboardOwnerMonth[];
}
/** Distinct counts over the selected month or quarter, or over all time. */
export interface DashboardPeriodStats {
  contributors: number;
  tasks: number;
  byOwner: { ownerType: BudgetOwnerType; ownerId: string; contributors: number; tasks: number }[];
}
export interface DashboardSeries {
  /** The window's buckets, oldest first. */
  months: DashboardMonth[];
  /** What a bucket covers: a month, or a quarter (keyed by its first month) in a long all-time window. */
  bucket: "month" | "quarter";
  period: DashboardPeriodStats;
  treasuries: { id: string; name: string }[];
}
/** Treasury inflows and internal transfers of the trailing window, by month. */
export interface DashboardFlows {
  months: FlowMonth[];
}
/**
 * Previous wallets whose imported history is in the series (their id stands
 * in the treasury slot of a spend cell), and the tokens that history uses.
 */
export interface DashboardLegacy {
  wallets: { id: string; name: string }[];
  assets: LegacyToken[];
}
/** GET /api/dashboard: the budgets data plus the chart series, flows and inflows. */
export interface DashboardResponse extends BudgetsResponse {
  incoming: BudgetIncomingItem[];
  series: DashboardSeries;
  flows: DashboardFlows;
  legacy: DashboardLegacy;
  /** Funding sources, which name the Funding flow's tagged income. */
  fundingSources: { id: string; name: string }[];
}

// --- Funding sources ------------------------------------------------------------

/** POST /api/funding/sources, POST /api/funding/commitments */
export interface FundingCreatedResponse {
  id: string;
}
/** POST /api/funding/commitments/[id]/schedule */
export interface FundingScheduleResponse {
  periods: number;
}

// --- Governance (proposals and voting) --------------------------------------------

/** POST /api/proposals */
export interface CreateProposalResponse {
  id: string;
  number: number;
  /** "discussion", "voting", or "cancelled" when nobody could vote. */
  state: string;
}
/** POST /api/proposals/[id]/ballot: the text the voter's wallet signs. */
export interface BallotTextResponse {
  text: string;
  signedAt: string;
}
/** POST /api/proposals/[id]/vote */
export interface CastVoteResponse {
  ballotsCast: number;
}
/** POST /api/proposals/[id]/advance, /withdraw, /cancel, /execute */
export interface ProposalStateResponse {
  state: string;
  executionState: string | null;
}
/** GET / POST /api/governance/discord: governance Discord channel on the connected server. */
export interface GovernanceDiscordStatus {
  serverConnected: boolean;
  serverLabel: string | null;
  channelId: string | null;
  /** Discord channel type: 0 text, 5 announcement, 15 forum. */
  channelType: number | null;
  lastPostedAt: string | null;
  lastError: string | null;
}
export interface GovernanceDiscordResponse {
  discord: GovernanceDiscordStatus;
  /** Channels the bot can see (GET with channels=1, or after connect). */
  channels?: { id: string; name: string; type: number }[];
}
/** GET /api/governance/community-settings: the community-level settings (0059). */
export interface GovernanceCommunitySettingsResponse {
  settings: GovernanceCommunitySettings;
}
/** GET /api/proposals/electorate */
export interface ElectoratePreviewResponse {
  /** Members in the electorate, before recusal. */
  count: number;
  /** Members who could cast a ballot: `count`, minus beneficiaries when they are recused. */
  eligible: number;
}

// --- Payment history (previous wallets) ------------------------------------------

export interface LegacyWalletSummary {
  id: string;
  name: string;
  address: string | null;
  createdAt: string;
  rowCount: number;
  firstPaidOn: string | null;
  lastPaidOn: string | null;
}
export interface LegacyImportSummary {
  id: string;
  legacyWalletId: string;
  fileName: string;
  createdAt: string;
  createdBy: string;
  /** Lines the import added; `rowCount` is what is still stored. */
  lineCount: number;
  rowCount: number;
  firstPaidOn: string | null;
  lastPaidOn: string | null;
  /** Per token over the whole import (`workgroupId` null). */
  totals: LegacyTotal[];
}
/** GET /api/legacy-history */
export interface LegacyHistoryOverview {
  wallets: LegacyWalletSummary[];
  imports: LegacyImportSummary[];
}
/** POST /api/legacy-history/preview: the plan, its rows possibly cut short. */
export interface LegacyHistoryPreview extends LegacyImportPlan {
  rowsTruncated: boolean;
}
/** POST /api/legacy-history/import */
export interface LegacyHistoryImportResponse {
  importId: string;
  inserted: number;
  skipped: number;
  replaced: boolean;
}
export interface LegacyPaymentView {
  id: string;
  importId: string;
  legacyWalletId: string;
  lineNo: number;
  recipientRef: string;
  recipientLabel: string;
  task: string;
  paidOn: string;
  budgetMonth: string;
  workgroupId: string;
  workgroupName: string;
  workgroupArchived: boolean;
  /** Base units per token. */
  amounts: (LegacyToken & { amount: string })[];
}
/** POST /api/legacy-history/wallets */
export interface LegacyWalletCreatedResponse {
  id: string;
}
/** POST /api/legacy-history/workgroup */
export interface LegacyWorkgroupResponse {
  workgroupId: string;
}
/** GET /api/legacy-history/rows */
export interface LegacyRowsResponse {
  rows: LegacyPaymentView[];
  total: number;
}

// --- Workgroup routing --------------------------------------------------------

export interface WorkgroupTreasuryAssignment {
  id: string;
  /** Null = any community wallet. */
  treasuryId: string | null;
  /** "YYYY-MM-DD", the first day of the period it starts. */
  startsOn: string;
  reason: string | null;
  createdBy: string;
  createdAt: string;
}
/** GET /api/workgroups/routing: the wallet in force and when a change could start. */
export interface WorkgroupRoutingStatus {
  treasuryId: string | null;
  cadence: "monthly" | "quarterly";
  /** "YYYY-MM-DD" of the current and next budget period starts. */
  currentStart: string;
  nextStart: string;
  /** The current period already has payouts, so a change can only start next period. */
  currentBlocked: boolean;
  history: WorkgroupTreasuryAssignment[];
}
/** POST /api/workgroups/routing: the period start the change took effect. */
export interface WorkgroupRoutingResponse {
  startsOn: string;
}

// --- GitHub -------------------------------------------------------------------

export interface GithubRepoOption {
  id: number;
  fullName: string;
  private: boolean;
  workgroupId: string | null;
  payableLabel: string | null;
  importStatus: string | null;
  /** "" when the paid-status move is disabled for this repo. */
  paidStatus: string | null;
}
export interface GithubInstallationOption {
  installationId: number;
  accountLogin: string;
  accountType: string | null;
  /** Set when GitHub could not list this installation's repos; the rest still load. */
  error?: string;
  repos: GithubRepoOption[];
}
export interface GithubReposResponse {
  installations: GithubInstallationOption[];
}
export interface SyncRepoResponse {
  synced: number;
  deleted: number;
}
/** The editable fields of a GitHub issue, as the board's editors submit them. */
export interface GithubIssueEditInput {
  title?: string;
  /** Null clears the issue body. */
  body?: string | null;
  /** The issue's complete label set. */
  labels?: string[];
  state?: "open" | "closed";
  /** Project v2 Status option name to move the item to. */
  status?: string;
  /** Complete GitHub assignee login set; [] clears. */
  assignees?: string[];
  /** Bounty number fields by project field name; "" clears a field. */
  amounts?: Record<string, string>;
}
/** One github task_assignees row after an assignee edit + re-sync. */
export interface GithubAssigneeSyncRow {
  id: string;
  ghLogin: string;
  wallet: string | null;
}
/** POST /api/github/issue: an in-app issue edit pushed to GitHub, then re-synced. */
export interface GithubIssueUpdateResponse {
  /** The Status option the item now sits in, when a move landed; null otherwise. */
  movedToStatus: string | null;
  /** Bounty field names the project has no such field for (nothing written for them). */
  missingAmountFields: string[];
  /** The sync that followed the write: tasks imported/updated, and removed. */
  synced: number;
  deleted: number;
  /** The edited task no longer matches the import rule and was removed. */
  taskRemoved: boolean;
  /**
   * Fresh github assignee rows after a sync that followed an assignees edit
   * (ids change when logins are added). Absent when assignees were not edited.
   */
  githubAssignees?: GithubAssigneeSyncRow[];
}
/** POST /api/github/issue kind=create: a new issue opened on GitHub and added to the project. */
export interface GithubIssueCreateResponse {
  number: number;
  url: string;
  itemNodeId: string;
}
/** GET /api/github/editor-options: assignable users + project number fields. */
export interface GithubEditorOptionsResponse {
  assignableLogins: string[];
  numberFieldNames: string[];
}
/** POST /api/github/project-field: ensure a bounty NUMBER field on the project. */
export interface GithubProjectFieldResponse {
  fieldName: string;
  created: boolean;
  /** On-chain unit when created from a wallet token; null for ADA. */
  unit: string | null;
}
export interface InstallUrlResponse {
  url: string;
}
export type { LiveBoardResponse };

// --- Developer tools ----------------------------------------------------------

/** /api/dev/cron: one scheduled job run to completion. */
export interface DevCronRunResponse {
  job: CronJobId;
  /** Wall-clock duration of the run. */
  ms: number;
  /** Exactly what the cron route would have returned. */
  result: ReconcileSweepResult | GithubSyncSweepResult | CallsSyncResult;
}

/** GET /api/dev/anchor-test: the treasuries the developer's wallet can pick. */
export interface DevAnchorTreasuriesResponse {
  treasuries: { id: string; name: string; network: number; communityName: string; slug: string }[];
}
/** POST /api/dev/anchor-test: the pending anchor transaction to sign. */
export interface DevAnchorTestResponse extends BuildTxResponse {
  slug: string;
  /** The label-190002 record the transaction carries. */
  record: unknown;
}

// --- IPFS ---------------------------------------------------------------------

export interface IpfsGatewayResponse {
  gateway: string;
}
export interface IpfsSignUploadResponse {
  url: string;
  gateway: string;
}
export interface WorkgroupLifecycleStatus {
  archivedAt: string | null;
  outstandingTasks: number;
  pendingPayouts: number;
  canDelete: boolean;
}
export interface BudgetResetStatus {
  revision: number;
  hasBudgets: boolean;
  blockedReason: string | null;
}

// --- Agent API (/api/v1 and the MCP tools, src/lib/api/v1) --------------------
//
// Amounts are exact decimal strings in display units (ADA, not lovelace),
// never floats; links are absolute app URLs a model can hand to the user.

/** GET /api/v1/me (MCP guild_whoami). */
export interface V1MeResponse {
  wallet: string;
  /** The OAuth client acting for the wallet; null for the app's own session. */
  client: string | null;
  scopes: string[];
}

export interface V1Community {
  slug: string;
  name: string;
  description: string | null;
  network: "mainnet" | "preprod";
  visibility: string;
  /** owner, admin or member. */
  role: string;
  url: string;
}

/** GET /api/v1/communities (MCP community_list). */
export interface V1CommunitiesResponse {
  communities: V1Community[];
}

export interface V1TreasuryBalance {
  ada: string;
  lovelace: string;
  utxoCount: number;
  tokens: { unit: string; ticker: string | null; name: string | null; quantity: string; decimals: number }[];
}

export interface V1PendingTransaction {
  id: string;
  kind: string;
  description: string | null;
  /** The branch of the treasury script it was built for: base, recovery, cosigned or bypass. */
  spendingPath: SpendingPath;
  signatures: number;
  /** Signatures the transaction's own path needs. */
  requiredSignatures: number;
  rejections: number;
  createdAt: string;
  url: string;
}

export interface V1Treasury {
  id: string;
  name: string;
  address: string;
  network: "mainnet" | "preprod";
  /** plain, clawback, lock_until or cosigner. */
  template: TreasuryTemplate;
  /** The lock date of a clawback or lock-until treasury. */
  lockUntil: string | null;
  /** "2 of 3 signers", with what the template adds. */
  signingRule: string;
  /** Signatures the treasury's default path needs. */
  requiredSignatures: number;
  signers: { name: string | null; address: string; group: SignerGroup }[];
  /** Null when balances were not asked for or the chain could not be read. */
  balance: V1TreasuryBalance | null;
  balanceError: string | null;
  pendingTransaction: V1PendingTransaction | null;
}

/** GET /api/v1/communities/[community]/treasuries (MCP treasury_overview). */
export interface V1TreasuriesResponse {
  community: { slug: string; name: string; network: "mainnet" | "preprod" };
  treasuries: V1Treasury[];
  url: string;
}

export interface V1Task {
  number: number;
  title: string;
  workgroup: string;
  /** Board column, when the task sits on one. */
  column: string | null;
  source: "native" | "github";
  /** none, payable, queued, paid or reconciled. */
  payState: string;
  archived: boolean;
  /** Reward per assignee, ticker -> amount: every assignee is paid all of it. */
  reward: Record<string, string>;
  assignees: { name: string; wallet: string | null }[];
  /** True when the task can go into a payout now: payable, ≥1 assignee, every one linked. */
  readyToPay: boolean;
  /** "YYYY-MM" the payout counts against, once set. */
  budgetMonth: string | null;
  paidTxHash: string | null;
  githubUrl: string | null;
  url: string;
}

/** GET /api/v1/communities/[community]/tasks (MCP task_list). */
export interface V1TasksResponse {
  community: { slug: string; name: string };
  tasks: V1Task[];
  /** Tasks matching the filter, of which `tasks` is the newest `limit`. */
  total: number;
  /** Live payable tasks in the whole community, whatever the filter. */
  payableCount: number;
}

export interface V1BudgetLine {
  owner: string;
  ownerType: "workgroup" | "treasury";
  cadence: "monthly" | "quarterly";
  period: string;
  token: string;
  budget: string;
  spent: string;
  remaining: string;
}

/** GET /api/v1/communities/[community]/budgets (MCP budget_summary). */
export interface V1BudgetsResponse {
  community: { slug: string; name: string };
  view: "month" | "quarter" | "recurring";
  month: string;
  budgets: V1BudgetLine[];
  totals: { token: string; budget: string; spent: string; remaining: string }[];
  recentSpending: { owner: string; kind: string; title: string; token: string; amount: string; status: string; createdAt: string }[];
  url: string;
}

export interface V1Proposal {
  number: number;
  /** decision, budget, workgroup or task. */
  kind: string;
  /** discussion, voting, passed, rejected, expired (no quorum), withdrawn or cancelled. */
  state: string;
  title: string;
  /** The proposal's text, cut at 2000 characters. */
  text: string;
  discussionUrl: string | null;
  /** Auto-created Discord discussion thread URL when Governance Discord is connected. */
  discordDiscussionUrl: string | null;
  proposer: string;
  /** What passing it changes, one line each (budget changes, the workgroup, the task). */
  changes: string[];
  decidedBy: string;
  electorate: string;
  /** Voters, fixed when voting opened; null before. */
  voters: number | null;
  ballotsCast: number;
  createdAt: string;
  votingOpensAt: string;
  votingClosesAt: string | null;
  closedAt: string | null;
  /** Counts once voting closed; ballots stay hidden while it runs unless the community shows them. */
  result: { outcome: string; counts: Record<string, number> } | null;
  /** Whether a passed proposal was carried out: pending, applied or failed (with why). */
  carriedOut: { state: string; error: string | null } | null;
  endReason: string | null;
  /** The caller's own signed vote, if any. */
  myVote: { choice: string; reason: string | null; signedAt: string } | null;
  /** The caller may sign a ballot now (in the electorate, not recused, voting open). */
  canVote: boolean;
  /** sha256 fingerprints every ballot signs: the proposal's content and its rules. */
  contentHash: string;
  rulesHash: string;
  /** sha256 of the fixed voter list, once voting opened (null before, and for older proposals). */
  electorateHash: string | null;
  /** blake2b-256 hash of the frozen signed tally, once the proposal is final after a vote. */
  tallyHash: string | null;
  /** Transaction hashes of the confirmed on-chain anchors (label 190002), per step; null where none is confirmed. */
  anchors: { proposed: string | null; opened: string | null; closed: string | null };
  url: string;
}

/** GET /api/v1/communities/[community]/proposals (MCP proposal_list). */
export interface V1ProposalsResponse {
  community: { slug: string; name: string };
  proposals: V1Proposal[];
  /** Proposals matching the filter, of which `proposals` is the newest `limit`. */
  total: number;
}

export interface V1Member {
  /** Handle, GitHub login, else the short wallet, as the app shows them. */
  name: string;
  /** owner, admin or member. */
  role: string;
  wallet: string;
  githubUsername: string | null;
  /** The live workgroups they lead. */
  leads: string[];
}

/** GET /api/v1/communities/[community]/members (MCP member_list). */
export interface V1MembersResponse {
  community: { slug: string; name: string };
  members: V1Member[];
  url: string;
}

/** GET /api/v1/communities/[community]/transactions/[tx] (MCP transaction_detail). */
export interface V1TransactionDetailResponse {
  community: { slug: string; name: string };
  transaction: V1Transaction;
  /** Its own spending path's rule, counted by address as the signing page counts. */
  signing: {
    rule: string;
    requiredSignatures: number;
    signed: { name: string | null; wallet: string }[];
    rejected: { name: string | null; wallet: string }[];
    /** Signers of the path who have done neither, while it is pending. */
    stillToSign: { name: string | null; wallet: string }[];
    readyToSubmit: boolean;
  };
  /** A payout: one line per task, wallet and token. */
  payouts: { recipient: string; wallet: string; task: number; taskTitle: string; workgroup: string; token: string; amount: string }[];
  /** A payment: one line per recipient and token; transfer = to one of the community's own treasuries. */
  payments: { recipient: string; wallet: string; transfer: boolean; budgetMonth: string | null; token: string; amount: string }[];
  mints: { asset: string; ticker: string | null; kind: string; quantity: string; recipient: string; policyId: string }[];
  /** Network fee in ADA, read from the transaction. */
  fee: string | null;
  /** Its CIP-20 message, if any. */
  message: string | null;
  /** The Treasury Guild records it carries, decoded from its own CBOR: label 190001 (payout or payment) and 190002 (proposal anchors). */
  onChainRecord: { payout: unknown; payment: unknown; anchors: unknown[] | null };
  /** The app-held co-signer's decisions on it, newest first. */
  cosigner: { at: string; trigger: string; passed: boolean; problems: string[]; signed: boolean; error: string | null }[];
}

/** Planned vs received for one token (display units). */
export interface V1FundingFigures {
  token: string;
  /** The whole commitment; null when it has no end. */
  planned: string | null;
  /** Planned up to the current period. */
  due: string;
  received: string;
  /** received − due: positive is ahead of the plan, negative behind. */
  difference: string;
  /** planned − received; null when open-ended. */
  remaining: string | null;
}

/** GET /api/v1/communities/[community]/funding (MCP funding_summary). */
export interface V1FundingResponse {
  community: { slug: string; name: string };
  sources: {
    name: string;
    description: string | null;
    url: string | null;
    totals: V1FundingFigures[];
    commitments: {
      name: string;
      /** one_off, recurring or schedule. */
      kind: string;
      /** "Monthly from Jan 2026 to Dec 2026". */
      plan: string;
      note: string | null;
      figures: V1FundingFigures[];
      /** The latest periods of a recurring commitment or schedule, token -> amount. */
      periods: { period: string; planned: Record<string, string>; received: Record<string, string>; runningDifference: Record<string, string> }[];
    }[];
    /** Received from the source but tied to no commitment, token -> amount. */
    unassigned: Record<string, string>;
  }[];
  url: string;
}

export interface V1Call {
  id: string;
  title: string;
  workgroup: string | null;
  /** discord, zoom, meet or manual (check-in). */
  platform: string;
  startsAt: string;
  endsAt: string;
  /** Paid to each qualifying attendee, ticker -> amount. */
  rewardEach: Record<string, string>;
  /** Discord snapshots or Zoom/Meet minutes an attendee needs. */
  threshold: { snapshots: number; minutes: number };
  /** open, or finalized (attendance paid into tasks). */
  state: string;
  /** Attendees by standing: rewarded, ready (the next finalize pays them), unlinked (no wallet yet), below-threshold, excluded. */
  attendees: Record<string, number>;
  url: string;
}

/** GET /api/v1/communities/[community]/calls (MCP call_list). */
export interface V1CallsResponse {
  community: { slug: string; name: string };
  calls: V1Call[];
  /** One call's attendee list, when asked for by id. */
  attendees: {
    name: string;
    wallet: string | null;
    source: string;
    minutes: number;
    snapshots: number;
    status: string;
    standing: string;
    /** The attendance task that paid them. */
    task: number | null;
  }[] | null;
  url: string;
}

/** GET /api/v1/communities/[community]/proposals/[number] (MCP proposal_detail). */
export interface V1ProposalDetailResponse {
  community: { slug: string; name: string };
  /** As proposal_list describes it, with the full text. */
  proposal: V1Proposal;
  /** Lifecycle steps, oldest first: created, voting_opened, closed, executed, execution_failed, withdrawn, cancelled. */
  events: { action: string; by: string | null; detail: Record<string, unknown> | null; at: string }[];
  /** Voters fixed when voting opened, and how many of them are recused. */
  voters: number;
  recused: number;
  /** Every ballot (voter, choice, reason) once ballots are visible; null while they stay hidden. */
  ballots: { voter: string; choice: string; reason: string | null; signedAt: string }[] | null;
  ballotsHidden: string | null;
  /** The frozen signed tally: its blake2b hash and the outside copies (IPFS CID). */
  tally: { hash: string; frozenAt: string; copies: { store: string; locator: string }[] } | null;
  /** What carrying it out made. */
  created: { workgroupBoard: string } | { taskNumber: number; taskBoard: string } | null;
}

/** POST /api/v1/communities/[community]/proposals/preview (MCP proposal_preview). Nothing is created. */
export interface V1ProposalPreviewResponse {
  community: { slug: string; name: string };
  proposal: {
    kind: string;
    title: string;
    /** The proposal's text, cut at 2000 characters. */
    text: string;
    discussionUrl: string | null;
    /** What passing it changes, one line each. */
    changes: string[];
    decidedBy: string;
    electorate: string;
    discussionHours: number;
    votingHours: number;
    /** If created now. */
    votingOpensAround: string;
    votingClosesAround: string;
  };
  /** What creating it does beyond the proposal itself. */
  effects: string[];
  /** What the assistant must do with this preview. */
  next: string;
  /** The only input proposal_create takes; bound to this connection. */
  draftToken: string;
  expiresAt: string;
}

/**
 * What every `*_preview` write tool (other than proposal_preview) answers:
 * nothing is done yet; draft_confirm does it with `draftToken`.
 */
export interface V1DraftPreview {
  community: { slug: string; name: string };
  /** The action draft_confirm will run: proposal_withdraw, payout_create, task_save, call_create or call_finalize. */
  action: string;
  /** One line saying what confirming does. */
  summary: string;
  /** What the action would do, in the action's own shape. */
  details: Record<string, unknown>;
  /** What doing it causes beyond the change itself. */
  effects: string[];
  /** Warnings the user should see before agreeing (budget problems, for one). */
  problems?: string[];
  /** What the assistant must do with this preview. */
  next: string;
  /** The only input draft_confirm takes; bound to this connection. */
  draftToken: string;
  expiresAt: string;
}

/** draft_confirm on a proposal_withdraw draft. */
export interface V1ProposalWithdrawResponse {
  community: { slug: string; name: string };
  /** False when it had been withdrawn already (a repeated confirmation). */
  created: boolean;
  number: number;
  title: string;
  state: string;
  url: string;
}

/** draft_confirm on a task_save draft. */
export interface V1TaskSaveResponse {
  community: { slug: string; name: string };
  /** False when this draft had already been carried out. */
  created: boolean;
  /** "created" or "updated". */
  change: string;
  number: number;
  title: string;
  workgroup: string;
  url: string;
}

/** draft_confirm on a call_create draft. */
export interface V1CallCreateResponse {
  community: { slug: string; name: string };
  created: boolean;
  callId: string;
  title: string;
  url: string;
}

/** draft_confirm on a call_finalize draft. */
export interface V1CallFinalizeResponse {
  community: { slug: string; name: string };
  /** False when nothing was left to pay (finalized before). */
  created: boolean;
  /** Numbers of the attendance tasks this confirmation created. */
  tasks: number[];
  /** Attendees paid into those tasks, and qualifying attendees still without one. */
  paid: number;
  remaining: number;
  url: string;
}

/** draft_confirm on a payout_create draft: a pending transaction for the signers. */
export interface V1PayoutCreateResponse {
  community: { slug: string; name: string };
  /** False when this draft had already made its transaction. */
  created: boolean;
  txId: string;
  txHash: string | null;
  treasury: string;
  /** Signatures it needs before it can be submitted, in the app. */
  requiredSignatures: number;
  url: string;
}

/** POST /api/v1/drafts/confirm (MCP draft_confirm): the action's own answer. */
export type V1DraftConfirmResponse = { action: string } & (
  | V1ProposalCreateResponse
  | V1ProposalWithdrawResponse
  | V1TaskSaveResponse
  | V1CallCreateResponse
  | V1CallFinalizeResponse
  | V1PayoutCreateResponse
);

/** POST /api/v1/communities/[community]/proposals/create (MCP proposal_create). */
export interface V1ProposalCreateResponse {
  community: { slug: string; name: string };
  /** False when this draft had already been confirmed: the proposal it created then. */
  created: boolean;
  number: number;
  /** discussion, voting, or cancelled when nobody could vote. */
  state: string;
  title: string;
  votingOpensAt: string;
  votingClosesAt: string | null;
  url: string;
}

export interface V1SigningQueueItem {
  community: { slug: string; name: string };
  treasury: string;
  id: string;
  /** payout, payment, mint or anchor. */
  kind: string;
  description: string | null;
  spendingPath: SpendingPath;
  signatures: number;
  requiredSignatures: number;
  rejections: number;
  /** The caller has signed it already. */
  signedByMe: boolean;
  /** The caller rejected it. */
  rejectedByMe: boolean;
  /** Enough signatures are in: it can be submitted from the app. */
  readyToSubmit: boolean;
  createdAt: string;
  url: string;
}

/** GET /api/v1/me/signing-queue (MCP signing_queue). */
export interface V1SigningQueueResponse {
  /** Pending transactions, across the caller's communities, whose signature rule includes the caller; oldest first. */
  transactions: V1SigningQueueItem[];
  /** How many of them still wait for the caller (neither signed nor rejected). */
  waitingOnMe: number;
}

export interface V1Transaction {
  id: string;
  treasury: string;
  /** payout, payment, mint or anchor. */
  kind: string;
  /** pending, submitted, confirmed or rejected. */
  state: string;
  description: string | null;
  spendingPath: SpendingPath;
  /** On-chain hash; the transaction exists on chain only once submitted. */
  txHash: string | null;
  signatures: number;
  rejections: number;
  createdAt: string;
  submittedAt: string | null;
  /** When the chain included it; null until confirmed. */
  blockTime: string | null;
  /** What the budget check found when it was built (warn mode). */
  spendProblems: string[];
  url: string;
}

/** GET /api/v1/communities/[community]/transactions (MCP transaction_list). */
export interface V1TransactionsResponse {
  community: { slug: string; name: string };
  transactions: V1Transaction[];
  /** Transactions matching the filter, of which `transactions` is the newest `limit`. */
  total: number;
  url: string;
}

export interface V1Workgroup {
  id: string;
  name: string;
  description: string | null;
  source: "native" | "github";
  archived: boolean;
  /** The treasury the workgroup is paid from this period; null = any. */
  treasury: string | null;
  leads: { name: string; wallet: string }[];
  url: string;
}

/** GET /api/v1/communities/[community]/workgroups (MCP workgroup_list). */
export interface V1WorkgroupsResponse {
  community: { slug: string; name: string };
  workgroups: V1Workgroup[];
}

export interface V1Incoming {
  txHash: string;
  treasury: string;
  /** The community treasury it came from, for an internal transfer. */
  fromTreasury: string | null;
  ada: string;
  /** Token label -> amount in display units. */
  tokens: Record<string, string>;
  blockTime: string | null;
  /** unclassified, contribution, revenue, refund, transfer or other. */
  type: string;
  /** Waiting for an admin to match it to a payout (a possible refund). */
  needsReview: boolean;
}

/** GET /api/v1/communities/[community]/incoming (MCP incoming_list). */
export interface V1IncomingResponse {
  community: { slug: string; name: string };
  incoming: V1Incoming[];
  url: string;
}

// --- Agent API OAuth (consent page, Settings connections) ---------------------

/** GET /api/oauth/request: what the consent page asks the user to approve. */
export interface OAuthRequestResponse {
  clientId: string;
  clientName: string;
  /** The domain vouching for the client (its metadata document); null = the name is self-declared. */
  verifiedDomain: string | null;
  /** Where the browser returns after the decision. */
  redirectHost: string;
  /** The return address is a program on this computer (CLI, desktop app), not a website. */
  redirectIsLocal: boolean;
  scopes: { scope: string; description: string }[];
}

/** POST /api/oauth/decision: where to send the browser (the client, with a code or an error). */
export interface OAuthDecisionResponse {
  redirectTo: string;
}

export interface OAuthConnection {
  clientId: string;
  clientName: string;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
}

/** GET /api/oauth/connections: the AI clients this wallet approved. */
export interface OAuthConnectionsResponse {
  connections: OAuthConnection[];
}
