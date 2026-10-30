// Shared vocabulary: enum-like constants for DB columns and UI state that
// used to be scattered as magic numbers/strings. Client-safe (no I/O).

/** transactions.state */
/** Postgres error codes the app reacts to (PostgREST passes them through). */
export const PgCode = {
  UniqueViolation: "23505",
  ForeignKeyViolation: "23503",
  CheckViolation: "23514",
  SerializationFailure: "40001",
  DeadlockDetected: "40P01",
  InsufficientPrivilege: "42501",
  NoDataFound: "P0002",
} as const;

export const TxState = {
  Pending: 0,
  Submitted: 1,
  Confirmed: 2,
  Rejected: 3,
} as const;
export type TxState = (typeof TxState)[keyof typeof TxState];

export type StateTone = "yellow" | "blue" | "green" | "red";

export const TX_STATE_META: Record<TxState, { label: string; tone: StateTone }> = {
  [TxState.Pending]: { label: "Pending", tone: "yellow" },
  [TxState.Submitted]: { label: "Submitted", tone: "blue" },
  [TxState.Confirmed]: { label: "Confirmed", tone: "green" },
  [TxState.Rejected]: { label: "Rejected", tone: "red" },
};

export function txStateMeta(state: number): { label: string; tone: StateTone } {
  return TX_STATE_META[state as TxState] ?? { label: `State ${state}`, tone: "yellow" };
}

/** transactions.kind */
export const TxKind = {
  Payout: "payout",
  Mint: "mint",
  /** A manual payment from the Payments page: outside addresses, members or another treasury. */
  Payment: "payment",
  /** Metadata only, no outputs: proposal anchors (label 190002); change back to the treasury. */
  Anchor: "anchor",
  /** Stake registration / delegation / deregistration / withdrawal / vote-delegation (SDK only). */
  Stake: "stake",
  /** DRep registration / update / retirement (SDK only). */
  Drep: "drep",
  /** On-chain governance votes as the treasury's script DRep (SDK only). */
  Vote: "vote",
  /** CIP-0146 (label 1854) self-spend: on-chain registration for co-signer discovery. */
  Registration: "registration",
} as const;
export type TxKind = (typeof TxKind)[keyof typeof TxKind];

/** Stake certificate / withdrawal actions stored on transactions.governance_action. */
export const StakeAction = {
  Register: "register",
  RegisterAndDelegate: "register_and_delegate",
  Delegate: "delegate",
  Deregister: "deregister",
  Withdraw: "withdraw",
  VoteDelegation: "vote_delegation",
} as const;
export type StakeAction = (typeof StakeAction)[keyof typeof StakeAction];

/** DRep certificate actions stored on transactions.governance_action. */
export const DrepAction = {
  Register: "register",
  Update: "update",
  Retire: "retire",
} as const;
export type DrepAction = (typeof DrepAction)[keyof typeof DrepAction];

/** treasuries.template: the fixed native-script shape of a treasury (migration 0061). */
export const TreasuryTemplate = {
  /** One flat all / any / atLeast group: the base signers. */
  Plain: "plain",
  /** any[base, all[recovery, after(slot)]]: the base signers always; the recovery signers from the lock date. */
  Clawback: "clawback",
  /** all[base, after(slot)]: nobody spends before the lock date; the treasury still receives. */
  LockUntil: "lock_until",
  /** any[all[base, sig(co-signer)], all[every base signer]]: the base rule plus a co-signer, or every base signer together. */
  Cosigner: "cosigner",
} as const;
export type TreasuryTemplate = (typeof TreasuryTemplate)[keyof typeof TreasuryTemplate];
export const TREASURY_TEMPLATES: readonly TreasuryTemplate[] = [
  TreasuryTemplate.Plain, TreasuryTemplate.Clawback, TreasuryTemplate.LockUntil, TreasuryTemplate.Cosigner,
];

/** treasury_signers.signer_group: which group of the script a key belongs to. */
export const SignerGroup = {
  Base: "base",
  Recovery: "recovery",
  Cosigner: "cosigner",
} as const;
export type SignerGroup = (typeof SignerGroup)[keyof typeof SignerGroup];

/** transactions.spending_path: the branch of the script a transaction was built for. */
export const SpendingPath = {
  /** The base group (plain, clawback before or after the date, lock-until after the date). */
  Base: "base",
  /** The recovery group of a clawback treasury, from the lock date; payments only. */
  Recovery: "recovery",
  /** The base rule plus the co-signer. */
  Cosigned: "cosigned",
  /** Every base signer together, without the co-signer. */
  Bypass: "bypass",
} as const;
export type SpendingPath = (typeof SpendingPath)[keyof typeof SpendingPath];
export const SPENDING_PATHS: readonly SpendingPath[] = [
  SpendingPath.Base, SpendingPath.Recovery, SpendingPath.Cosigned, SpendingPath.Bypass,
];

/** treasuries.cosigner_kind: who holds the co-signer key. */
export const CosignerKind = {
  /** A member's wallet, chosen at creation. */
  Member: "member",
  /** A key the app generated at creation and keeps encrypted. */
  App: "app",
} as const;
export type CosignerKind = (typeof CosignerKind)[keyof typeof CosignerKind];
/** treasury_signers.display_name of the app-held co-signer key. */
export const COSIGNER_DISPLAY_NAME = "Treasury Guild co-signer";

/** cosigner_decisions.trigger: what ran the co-signer check. */
export const CosignTrigger = {
  Sign: "sign",
  Manual: "manual",
  Sweep: "sweep",
} as const;
export type CosignTrigger = (typeof CosignTrigger)[keyof typeof CosignTrigger];

/** proposal_anchors.step: what an on-chain anchor (label 190002) records of a proposal. */
export const AnchorStep = {
  /** Content and rules hashes, due from creation. */
  Proposed: "proposed",
  /** The electorate hash, due once voting opened. */
  Opened: "opened",
  /** The final state, the frozen tally hash and counts, due once final. */
  Closed: "closed",
} as const;
export type AnchorStep = (typeof AnchorStep)[keyof typeof AnchorStep];
export const ANCHOR_STEPS: readonly AnchorStep[] = [AnchorStep.Proposed, AnchorStep.Opened, AnchorStep.Closed];

/** tasks.pay_state */
export const PayState = {
  None: "none",
  Payable: "payable",
  Queued: "queued",
  Paid: "paid",
  Reconciled: "reconciled",
} as const;
export type PayState = (typeof PayState)[keyof typeof PayState];

/** Tasks in these states are historical payment records: never re-priced,
 * never deleted by sync, never re-queued. */
export const SETTLED_PAY_STATES: readonly string[] = [
  PayState.Queued,
  PayState.Paid,
  PayState.Reconciled,
];

/** Tasks whose payout is on-chain: they live in the board's Paid column and
 * no longer move. */
export const PAID_PAY_STATES: readonly string[] = [PayState.Paid, PayState.Reconciled];

/** github_repos link defaults (repo card, link route). */
export const DEFAULT_PAYABLE_LABEL = "audited";
export const DEFAULT_IMPORT_STATUS = "In review";
export const DEFAULT_PAID_STATUS = "Paid";

/** payouts.status */
export const PayoutStatus = {
  Pending: "pending",
  Submitted: "submitted",
  Confirmed: "confirmed",
  WrittenBack: "written_back",
  Adjusted: "adjusted",
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];
/** Payout rows that count as spent: from submission on, whatever happened after. */
export const SPENT_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  PayoutStatus.Submitted,
  PayoutStatus.Confirmed,
  PayoutStatus.WrittenBack,
  PayoutStatus.Adjusted,
];

/** external_txs.import_status (null = not evaluated yet, or a failure to retry). */
export const ChainImportStatus = {
  /** Needs an admin; the reasons are in import_issues. */
  Blocked: "blocked",
  /** An admin dismissed it. */
  Ignored: "ignored",
  /** The label-190001 record is not a Treasury Guild one. */
  Skipped: "skipped",
} as const;
export type ChainImportStatus = (typeof ChainImportStatus)[keyof typeof ChainImportStatus];

/** Why an on-chain payout or payment could not be imported (import_issues[].code). */
export const ChainImportIssueCode = {
  UnsupportedVersion: "unsupported_version",
  BadMetadata: "bad_metadata",
  SlugMismatch: "slug_mismatch",
  WorkgroupMissing: "workgroup_missing",
  WorkgroupAmbiguous: "workgroup_ambiguous",
  WorkgroupArchived: "workgroup_archived",
  UnknownTicker: "unknown_ticker",
  NumberConflict: "number_conflict",
  AmountMismatch: "amount_mismatch",
  OutputMissing: "output_missing",
  UnknownTreasury: "unknown_treasury",
  TransferMismatch: "transfer_mismatch",
  MissingCbor: "missing_cbor",
  HashMismatch: "hash_mismatch",
  ImportFailed: "import_failed",
} as const;
export type ChainImportIssueCode = (typeof ChainImportIssueCode)[keyof typeof ChainImportIssueCode];

/** Why a payment-history CSV (or one of its lines) cannot be imported as is. */
export const LegacyIssueCode = {
  EmptyFile: "empty_file",
  UnterminatedQuote: "unterminated_quote",
  MissingColumn: "missing_column",
  DuplicateColumn: "duplicate_column",
  UnnamedColumn: "unnamed_column",
  BadTickerColumn: "bad_ticker_column",
  NoTickerColumns: "no_ticker_columns",
  TooManyTickers: "too_many_tickers",
  TooManyRows: "too_many_rows",
  FieldCount: "field_count",
  BadRecipient: "bad_recipient",
  EmptyTask: "empty_task",
  TaskTooLong: "task_too_long",
  BadDate: "bad_date",
  FutureDate: "future_date",
  EmptyWorkgroup: "empty_workgroup",
  WorkgroupTooLong: "workgroup_too_long",
  BadAmount: "bad_amount",
  AmountComma: "amount_comma",
  TooManyDecimals: "too_many_decimals",
  NoAmount: "no_amount",
  UnresolvedTicker: "unresolved_ticker",
  SameToken: "same_token",
  UnresolvedWorkgroup: "unresolved_workgroup",
  ArchivedWorkgroup: "archived_workgroup",
  DuplicateInFile: "duplicate_in_file",
} as const;
export type LegacyIssueCode = (typeof LegacyIssueCode)[keyof typeof LegacyIssueCode];

/** Limits of one payment-history upload. */
export const LEGACY_MAX_ROWS = 5000;
export const LEGACY_MAX_TICKERS = 20;
export const LEGACY_MAX_TASK_CHARS = 500;
export const LEGACY_MAX_CSV_CHARS = 1_000_000;

/** community_members.role */
export const Role = {
  Owner: "owner",
  Admin: "admin",
  Member: "member",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** communities.visibility */
export const Visibility = {
  Public: "public",
  Private: "private",
} as const;
export type Visibility = (typeof Visibility)[keyof typeof Visibility];

/** tasks.source / workgroups.kind */
export const TaskSource = {
  Github: "github",
  Native: "native",
} as const;
export type TaskSource = (typeof TaskSource)[keyof typeof TaskSource];

/** calls.provider: where the call happened (what a capture adapter reads). */
export const CallProvider = {
  Discord: "discord",
  Zoom: "zoom",
  Meet: "meet",
  Manual: "manual",
} as const;
export type CallProvider = (typeof CallProvider)[keyof typeof CallProvider];

export const CALL_PROVIDER_LABELS: Record<CallProvider, string> = {
  [CallProvider.Discord]: "Discord",
  [CallProvider.Zoom]: "Zoom",
  [CallProvider.Meet]: "Google Meet",
  [CallProvider.Manual]: "Other",
};

/** call_integrations.provider: the host account (or Discord server) a community connected. */
export const IntegrationProvider = {
  Discord: "discord",
  Zoom: "zoom",
  Google: "google",
} as const;
export type IntegrationProvider = (typeof IntegrationProvider)[keyof typeof IntegrationProvider];

/** contributor_identities.provider: accounts a wallet can link besides GitHub. */
export const IdentityProvider = {
  Discord: "discord",
  Google: "google",
} as const;
export type IdentityProvider = (typeof IdentityProvider)[keyof typeof IdentityProvider];

/** calls.state */
export const CallState = {
  Open: "open",
  Finalized: "finalized",
} as const;
export type CallState = (typeof CallState)[keyof typeof CallState];

/** call_attendees.provider: how the attendee got on the list. */
export const AttendeeSource = {
  Discord: "discord",
  Zoom: "zoom",
  Meet: "meet",
  Checkin: "checkin",
  Manual: "manual",
} as const;
export type AttendeeSource = (typeof AttendeeSource)[keyof typeof AttendeeSource];

/** call_attendees.status */
export const AttendeeStatus = {
  /** Subject to the call's presence threshold. */
  Auto: "auto",
  /** A manager's override: rewarded whatever the threshold says. */
  Confirmed: "confirmed",
  /** Never rewarded. */
  Excluded: "excluded",
} as const;
export type AttendeeStatus = (typeof AttendeeStatus)[keyof typeof AttendeeStatus];

// --- Governance (proposals and voting) --------------------------------------

/** proposals.kind / governance_settings.kind */
export const ProposalKind = {
  /** Budget changes that apply when passed ("budget consent"). */
  Budget: "budget",
  Workgroup: "workgroup",
  Task: "task",
  /** A free-text decision: nothing is applied. */
  Decision: "decision",
  /**
   * Add or remove leads of an existing workgroup. Available while the
   * workgroup kind is on; it has no settings row of its own.
   */
  Lead: "lead",
} as const;
export type ProposalKind = (typeof ProposalKind)[keyof typeof ProposalKind];

/** proposals.state */
export const ProposalState = {
  Discussion: "discussion",
  Voting: "voting",
  Passed: "passed",
  Rejected: "rejected",
  /** Voting ended without quorum. */
  Expired: "expired",
  /** By the proposer, before voting opened. */
  Withdrawn: "withdrawn",
  /** By an admin (with a reason), or when nobody could vote. */
  Cancelled: "cancelled",
} as const;
export type ProposalState = (typeof ProposalState)[keyof typeof ProposalState];

export const PROPOSAL_STATE_META: Record<ProposalState, { label: string; tone: StateTone | "default" }> = {
  [ProposalState.Discussion]: { label: "In discussion", tone: "default" },
  [ProposalState.Voting]: { label: "Voting", tone: "blue" },
  [ProposalState.Passed]: { label: "Passed", tone: "green" },
  [ProposalState.Rejected]: { label: "Rejected", tone: "red" },
  [ProposalState.Expired]: { label: "No quorum", tone: "yellow" },
  [ProposalState.Withdrawn]: { label: "Withdrawn", tone: "default" },
  [ProposalState.Cancelled]: { label: "Cancelled", tone: "default" },
};

/** proposals.execution_state: carrying out a passed proposal. */
export const ExecutionState = {
  Pending: "pending",
  Applied: "applied",
  Failed: "failed",
  NotApplicable: "not_applicable",
} as const;
export type ExecutionState = (typeof ExecutionState)[keyof typeof ExecutionState];

/** How a proposal is decided (governance_settings.method). */
export const DecisionMethod = {
  /** Agree / abstain / disagree / block: passes with no block and more agree than disagree. */
  Consent: "consent",
  /** Yes / no / abstain against a support threshold. */
  Majority: "majority",
  /** Passes at the deadline unless enough members object. */
  Lazy: "lazy",
} as const;
export type DecisionMethod = (typeof DecisionMethod)[keyof typeof DecisionMethod];

/** proposal_votes.choice */
export const VoteChoice = {
  Agree: "agree",
  Abstain: "abstain",
  Disagree: "disagree",
  Block: "block",
  Yes: "yes",
  No: "no",
  Object: "object",
} as const;
export type VoteChoice = (typeof VoteChoice)[keyof typeof VoteChoice];

/** The ballot choices of each method, in display order (checked again by cast_proposal_vote). */
export const METHOD_CHOICES: Record<DecisionMethod, readonly VoteChoice[]> = {
  [DecisionMethod.Consent]: [VoteChoice.Agree, VoteChoice.Abstain, VoteChoice.Disagree, VoteChoice.Block],
  [DecisionMethod.Majority]: [VoteChoice.Yes, VoteChoice.No, VoteChoice.Abstain],
  [DecisionMethod.Lazy]: [VoteChoice.Agree, VoteChoice.Object],
};
/** Choices that need a written reason. */
export const REASONED_CHOICES: readonly VoteChoice[] = [VoteChoice.Block, VoteChoice.Object];

/** Who votes on a proposal (governance_settings.electorate; evaluated by proposal_electorate). */
export const Electorate = {
  Members: "members",
  Admins: "admins",
  /** Admins and workgroup leads. */
  Managers: "managers",
  /** Leads, paid contributors and assignees of the workgroups concerned. */
  Workgroup: "workgroup",
  /** Members paid in the look-back window. */
  Contributors: "contributors",
  /** Current leads of the workgroups concerned. Lead changes only; not a settings choice. */
  Leads: "leads",
} as const;
export type Electorate = (typeof Electorate)[keyof typeof Electorate];

/** Who may make a proposal (governance_settings.proposers). */
export const Proposers = {
  Members: "members",
  /** Admins, and leads of every workgroup the proposal concerns. */
  Managers: "managers",
  Admins: "admins",
} as const;
export type Proposers = (typeof Proposers)[keyof typeof Proposers];

export const MAX_PROPOSAL_TITLE = 140;
export const MAX_PROPOSAL_BODY = 10_000;
export const MAX_VOTE_REASON = 500;

// --- Limits ---------------------------------------------------------------

/** Assignees per task: the task editor's cap, and the size of one attendance
 * task when a call is finalized (a task cannot span transactions). */
export const MAX_TASK_ASSIGNEES = 20;
/** Names accepted in one pasted attendee list. */
export const MAX_PASTED_ATTENDEES = 200;
/** Check-in opens this long before a call starts (and closes when it ends). */
export const CHECKIN_EARLY_MS = 15 * 60 * 1000;
/** Hard cap on distinct recipients in one payout or payment tx (tx size). */
export const MAX_PAYOUT_CONTRIBUTORS = 40;
/**
 * Request budgets for the abuse-prone API routes (enforceRateLimit): at most
 * `limit` requests per subject in each fixed window of `windowSeconds`.
 */
export const RATE_LIMITS = {
  /** Login challenges, per client IP. */
  authNonceIp: { limit: 10, windowSeconds: 60 },
  /** Login signatures, per client IP. */
  authVerifyIp: { limit: 20, windowSeconds: 60 },
  /** A manager's capture-now, per call: one Discord gateway connection per 30 s (MIN_SNAPSHOT_GAP_MS). */
  callCapture: { limit: 1, windowSeconds: 30 },
  /** Check-in code attempts, per wallet and call. */
  callCheckin: { limit: 10, windowSeconds: 600 },
  /** Signed IPFS upload URLs, per wallet. */
  ipfsUpload: { limit: 30, windowSeconds: 3600 },
  /** Chain lookups through the Koios proxy, per wallet. */
  chainProxy: { limit: 120, windowSeconds: 60 },
  /** New communities, per wallet. */
  communityCreate: { limit: 5, windowSeconds: 3600 },
  /** Contributor registrations, per wallet. */
  contributorRegister: { limit: 30, windowSeconds: 3600 },
  /** Payment-history previews and imports (CSV parsing), per wallet. */
  legacyHistory: { limit: 60, windowSeconds: 600 },
  /** New proposals, per wallet. */
  proposalCreate: { limit: 10, windowSeconds: 3600 },
  /** Ballot texts and signed ballots, per wallet. */
  proposalVote: { limit: 60, windowSeconds: 600 },
  /** Agent API: MCP requests and /api/v1 reads together, per wallet (one MCP POST is at most one tool call). */
  agentApi: { limit: 120, windowSeconds: 60 },
  /** Agent API OAuth: authorization requests and token grants, per client IP. */
  oauthAuthorize: { limit: 60, windowSeconds: 60 },
  oauthToken: { limit: 60, windowSeconds: 60 },
  /** Open Dynamic Client Registration, per client IP (every fresh connection registers). */
  oauthRegister: { limit: 20, windowSeconds: 3600 },
  /** Creating community invite links, per admin wallet. */
  inviteCreate: { limit: 20, windowSeconds: 3600 },
  /** Looking up an invite token before joining, per client IP. */
  invitePreview: { limit: 60, windowSeconds: 600 },
  /** Redeeming an invite (joining), per wallet. */
  inviteRedeem: { limit: 20, windowSeconds: 600 },
  /** GitHub App install state: one use per jti (matches the 10-minute OAuth state TTL). */
  githubInstallState: { limit: 1, windowSeconds: 600 },
  /** Public community join, per client IP. */
  communityJoinIp: { limit: 30, windowSeconds: 600 },
  /** Host OAuth callbacks (Discord / Zoom / Google), per client IP. */
  hostOauthCallback: { limit: 30, windowSeconds: 600 },
  /** Creating an SDK signer invite, per admin wallet. */
  signerDraftCreate: { limit: 20, windowSeconds: 3600 },
  /** Looking up an SDK signer invite before connecting, per client IP. */
  signerDraftPreview: { limit: 60, windowSeconds: 600 },
  /** A signer sending their stake and DRep keys, per wallet. */
  signerDraftContribute: { limit: 20, windowSeconds: 600 },
} as const satisfies Record<string, { limit: number; windowSeconds: number }>;
export type RateLimitBucket = keyof typeof RATE_LIMITS;
/** Rate-limit counters older than this are purged by the reconcile sweep. */
export const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Highest task number metadata or chain import may invent. Postgres
 * `integer` tops out at 2^31-1; staying below leaves headroom for
 * `max(number) + 1` assignment without overflow.
 */
export const MAX_TASK_NUMBER = 2_000_000_000;

/** Signers one treasury's native script may list. */
export const MAX_TREASURY_SIGNERS = 50;
/** A payment memo lands in on-chain metadata: one metadatum string at most. */
export const MAX_PAYMENT_MEMO_BYTES = 64;
/** Multi-asset outputs are larger; warn earlier when tokens are involved. */
export const TOKEN_CONTRIBUTOR_WARNING = 25;
/** A new mint policy time lock must be at least this far in the future. */
export const MIN_LOCK_LEAD_MS = 60 * 60 * 1000;

// --- Browser storage keys -------------------------------------------------

export const SIDEBAR_STORAGE_KEY = "treasury-guild-sidebar";
/** Per-community Overview setup checklist dismissals: `${communityId}:${itemId}` entries. */
export const SETUP_CHECKLIST_STORAGE_KEY = "treasury-guild-setup-checklist";

// --- Shared user-facing messages -----------------------------------------

export const MSG = {
  connectWallet: "Connect a wallet first",
  walletNotConnected:
    "Your wallet is not connected. Use Reconnect wallet in the top bar to sign.",
  walletSwitched:
    "The connected wallet is not the one you signed in with. Use Switch account in the top bar to sign as the connected wallet.",
  requestFailed: "Request failed",
  txNotPending: "Transaction is no longer pending",
  txAlreadyOnChain: "This transaction is already on-chain",
  txHasSignatures:
    "This transaction has signatures and cannot be deleted. Reject it, or wait until it is confirmed on-chain.",
  txChanged: "This transaction changed while you were responding. Reload it and try again.",
  pendingTxExists:
    "A pending transaction already exists for this treasury. Submit or reject it first.",
  lockedUntil: "This treasury is locked until",
  recoveryNotOpen: "The recovery signers can move funds from",
  recoveryPaymentsOnly: "The recovery path moves funds out: it builds payments only",
  pathNotOffered: "This treasury does not offer that spending path",
  notPathSigner: "Your wallet does not sign on this transaction's spending path",
  cosignerRefused: "The co-signer check refused this transaction",
} as const;
