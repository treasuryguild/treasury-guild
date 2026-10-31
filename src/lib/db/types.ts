// Row shapes for the Supabase tables, shared by server query helpers and
// client components. Client-safe: types and select-column constants only.
// Query helpers live in the sibling modules (server-only).

import type { ScriptType } from "@/lib/cardano/types";
import type { ChainImportIssue } from "@/lib/chainImport/types";
import type { ProposalPayload } from "@/lib/governance/payload";
import type { ProposalRules } from "@/lib/governance/rules";
import type { SpendProblem } from "@/lib/governance/spendCheck";
import type { ProposalTally } from "@/lib/governance/tally";
import type {
  AnchorStep,
  AttendeeSource,
  AttendeeStatus,
  CallProvider,
  CallState,
  ChainImportStatus,
  CosignerKind,
  CosignTrigger,
  DecisionMethod,
  DrepAction,
  Electorate,
  ExecutionState,
  IdentityProvider,
  IntegrationProvider,
  ProposalKind,
  Proposers,
  ProposalState,
  SignerGroup,
  SpendingPath,
  StakeAction,
  TreasuryTemplate,
  VoteChoice,
} from "@/lib/constants";

export interface CommunityRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  network: number;
  visibility: string;
  /** CoinGecko coin id for the Discord footer rate; null = date only. */
  discord_rate_coin: string | null;
  /** Fiat currency the rate is quoted in ("usd"). */
  discord_rate_currency: string;
  /** Main budget/spending token: "lovelace" or policyId + assetNameHex. Charted first on the Dashboard. */
  spending_unit: string;
  /**
   * The treasury whose base signers are community admins (null until the
   * first treasury exists). Other treasuries' signers are not auto-promoted.
   */
  primary_treasury_id: string | null;
}

export const COMMUNITY_COLUMNS =
  "id, slug, name, description, network, visibility, discord_rate_coin, discord_rate_currency, spending_unit, primary_treasury_id";

export interface CommunityMemberRow {
  community_id: string;
  wallet_address: string;
  role: string;
}

export interface ContributorRow {
  wallet_address: string;
  handle: string | null;
  github_username: string | null;
}

export type ContributorProfile = Pick<ContributorRow, "handle" | "github_username">;

/** community_members joined with the contributor profile. */
export interface MemberWithContributor {
  wallet_address: string;
  role: string;
  contributors: ContributorProfile | null;
}

export const MEMBER_WITH_CONTRIBUTOR_COLUMNS =
  "wallet_address, role, contributors(handle, github_username)";

/** A community invite link (token never stored; only its hash). */
export interface CommunityInviteRow {
  id: string;
  community_id: string;
  token_hash: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  last_used_at: string | null;
  revoked_at: string | null;
  label: string | null;
}

export const COMMUNITY_INVITE_COLUMNS =
  "id, community_id, token_hash, created_by, created_at, expires_at, max_uses, use_count, last_used_at, revoked_at, label";

/** Admin-facing invite fields (no token hash). */
export type CommunityInviteSummary = Omit<CommunityInviteRow, "token_hash">;

export const COMMUNITY_INVITE_SUMMARY_COLUMNS =
  "id, community_id, created_by, created_at, expires_at, max_uses, use_count, last_used_at, revoked_at, label";

/** An SDK treasury waiting for each base signer to connect and provide keys. */
export interface TreasurySignerDraftRow {
  id: string;
  community_id: string;
  token_hash: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  name: string;
  required: number;
  workgroup_id: string | null;
}

export interface TreasurySignerDraftSignerRow {
  draft_id: string;
  position: number;
  wallet_address: string;
  display_name: string | null;
  stake_address: string | null;
  drep_key_hash: string | null;
  contributed_at: string | null;
}

export const TREASURY_SIGNER_DRAFT_COLUMNS =
  "id, community_id, token_hash, created_by, created_at, expires_at, name, required, workgroup_id";

export const TREASURY_SIGNER_DRAFT_SIGNER_COLUMNS =
  "draft_id, position, wallet_address, display_name, stake_address, drep_key_hash, contributed_at";

export interface WorkgroupRow {
  id: string;
  community_id: string;
  name: string;
  description: string | null;
  kind: string;
  archived_at: string | null;
  /** Routes the workgroup to one treasury (NULL = any). */
  treasury_id: string | null;
}

export interface WorkgroupBudgetRow {
  id: string;
  workgroup_id: string;
  cadence: "monthly" | "quarterly";
  unit: string;
  amount: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TreasuryRow {
  id: string;
  community_id: string;
  name: string;
  network: number;
  /** The base group's threshold (meaningful for `atLeast`). */
  required: number;
  /** The base group's rule. */
  script_type: ScriptType;
  address: string;
  script_cbor: string;
  stake_credential_hash: string | null;
  /** The script's fixed shape (0061); the columns below exist exactly for the templates that use them. */
  template: TreasuryTemplate;
  /** The `after` slot of a clawback or lock-until treasury. */
  lock_slot: number | null;
  /** The same moment as a timestamp (derived from the slot). */
  lock_until: string | null;
  /** The recovery group's rule of a clawback treasury. */
  recovery_script_type: ScriptType | null;
  recovery_required: number | null;
  /** Who holds the co-signer key of a cosigner treasury. */
  cosigner_kind: CosignerKind | null;
  /** Set while an admin has archived the treasury; null while it can be chosen for new builds. */
  archived_at: string | null;
  /** Wallet of the admin who archived it; cleared on restore. */
  archived_by: string | null;
}

/** The columns list pages need to render/pick a treasury. */
export type TreasurySummary = Pick<
  TreasuryRow,
  "id" | "name" | "address" | "required" | "script_type" | "template" | "lock_until" | "recovery_script_type" | "recovery_required" | "cosigner_kind" | "archived_at" | "stake_credential_hash"
> & {
  /** The signers' groups only, so pages can count each group ("2 of 3"). */
  treasury_signers: Pick<TreasurySignerRow, "signer_group">[];
};
export const TREASURY_SUMMARY_COLUMNS =
  "id, name, address, required, script_type, template, lock_until, recovery_script_type, recovery_required, cosigner_kind, archived_at, stake_credential_hash, treasury_signers(signer_group)";

export interface TreasurySignerRow {
  treasury_id: string;
  wallet_address: string;
  key_hash: string;
  stake_key_hash: string | null;
  /** CIP-1854 role-3 DRep key hash (0075); null when unused / payment-script DRep fallback. */
  drep_key_hash: string | null;
  display_name: string | null;
  /** Which group of the script the key belongs to (0061). */
  signer_group: SignerGroup;
}

/** One run of the co-signer check on a co-signed transaction (0061). */
export interface CosignerDecisionRow {
  id: string;
  transaction_id: string;
  decided_at: string;
  trigger: CosignTrigger;
  passed: boolean;
  /** The problems in words; [] when it passed. */
  problems: string[];
  /** Whether the app's witness was added (only after a pass). */
  signed: boolean;
  /** Why the witness could not be added after a pass (0062); null otherwise. */
  error: string | null;
}
export const COSIGNER_DECISION_COLUMNS = "id, transaction_id, decided_at, trigger, passed, problems, signed, error";

/** Typed payload for stake / DRep / vote transactions (0075). */
export type GovernanceAction =
  | {
      kind: "stake";
      action: StakeAction;
      poolId?: string | null;
      /** Pool ticker when known at build (title uses this; poolId stays in details). */
      poolTicker?: string | null;
      dRepId?: string | null;
      /** CIP-119 givenName when known at build (title uses this; dRepId stays in details). */
      dRepName?: string | null;
      rewards?: string | null;
    }
  | {
      kind: "drep";
      action: DrepAction;
      dRepId: string;
      anchorUrl?: string | null;
    }
  | {
      kind: "vote";
      dRepId: string;
      votes: { txHash: string; certIndex: number; voteKind: "Yes" | "No" | "Abstain" }[];
    };

export interface TransactionRow {
  id: string;
  treasury_id: string;
  kind: string;
  tx_cbor: string;
  tx_hash: string | null;
  description: string | null;
  signed_addresses: string[];
  rejected_addresses: string[];
  state: number;
  created_by: string;
  submitted_at: string | null;
  created_at: string;
  /** Set by the reconcile cron once the Discord payout summary is posted. */
  discord_notified_at: string | null;
  /** What the budget check found at build time (warn mode, 0059); [] otherwise. */
  spend_problems: SpendProblem[];
  /** When the chain included it, set by the confirm poller (0060); null until confirmed. */
  block_time: string | null;
  /** The branch of the treasury script it was built for (0061); whose signatures count. */
  spending_path: SpendingPath;
  /** Stake / DRep / vote action details (0075); null for other kinds. */
  governance_action: GovernanceAction | null;
  /** Spend TTL slot stamped at build (0085); null = no automatic cancel release. */
  valid_to_slot: number | null;
  /** App co-signer claim window (0085); cancel refuses while recent. */
  cosign_claimed_at: string | null;
}

export type TransactionSummary = Pick<
  TransactionRow,
  | "id"
  | "treasury_id"
  | "kind"
  | "description"
  | "signed_addresses"
  | "state"
  | "tx_hash"
  | "created_at"
  | "spending_path"
  | "governance_action"
>;
export const TRANSACTION_SUMMARY_COLUMNS =
  "id, treasury_id, kind, description, signed_addresses, state, tx_hash, created_at, spending_path, governance_action";

export interface PayoutRow {
  id: string;
  transaction_id: string;
  task_id: string;
  contributor_wallet: string;
  unit: string;
  amount: string;
  status: string;
}

/**
 * One output of a manual payment (transactions.kind = 'payment'), per
 * recipient address and unit. A row with `recipient_treasury_id` is a
 * transfer to another of the community's treasuries and carries no budget
 * month; every other row is charged to the paying treasury's budget.
 */
export interface PaymentRow {
  id: string;
  transaction_id: string;
  community_id: string;
  treasury_id: string;
  recipient_wallet: string;
  recipient_treasury_id: string | null;
  /** Member handle or treasury name at build time. */
  label: string | null;
  unit: string;
  amount: string;
  /** "YYYY-MM-DD", day 1; null for a transfer. */
  budget_month: string | null;
  created_at: string;
}

export const PAYMENT_COLUMNS =
  "id, transaction_id, community_id, treasury_id, recipient_wallet, recipient_treasury_id, label, unit, amount, budget_month, created_at";

export interface CommunityAssetRow {
  community_id: string;
  field_name: string;
  unit: string;
  decimals: number;
}

export interface MintRow {
  id: string;
  transaction_id: string;
  asset_kind: "ft" | "nft";
  policy_id: string;
  policy_script_cbor: string;
  lock_slot: number | null;
  lock_until: string | null;
  asset_name: string;
  asset_name_hex: string;
  quantity: string;
  decimals: number;
  ticker: string | null;
  image_cid: string | null;
  recipient: string;
  metadata: Record<string, unknown>;
  created_at: string;
  treasury_id: string;
}

/** A mint row joined with its transaction's state (Mint page list). */
export type MintWithTx = MintRow & {
  transaction: { state: number; tx_hash: string | null } | null;
};

export const MINT_LIST_COLUMNS =
  "id, transaction_id, treasury_id, asset_kind, policy_id, policy_script_cbor, lock_slot, lock_until, asset_name, asset_name_hex, quantity, decimals, ticker, image_cid, recipient, metadata, created_at, transaction:transactions(state, tx_hash)";

export interface IncomingTxRow {
  tx_hash: string;
  treasury_id: string;
  from_addresses: string[];
  amount_lovelace: string;
  assets: Record<string, string> | null;
  block_time: string | null;
  matched: boolean;
  incoming_type: "unclassified" | "refund" | "contribution" | "revenue" | "transfer" | "other";
  requires_reconciliation: boolean;
  note: string | null;
  /** Another treasury of the community it came from (tag_internal_transfers). */
  from_treasury_id: string | null;
  /** The funding source (and commitment) an admin tied this inflow to (migration 0052). */
  funding_source_id: string | null;
  funding_commitment_id: string | null;
}

/**
 * An outgoing tx seen at a treasury address without a `transactions` row:
 * spent by another tool, or the app lost its record. Written by pollTreasury.
 */
export interface ExternalTxRow {
  tx_hash: string;
  treasury_id: string;
  block_height: number;
  block_time: string;
  fee_lovelace: string;
  /** Lovelace paid to other addresses (change excluded). */
  amount_lovelace: string;
  /** Tokens paid to other addresses, unit -> quantity. */
  assets: Record<string, string> | null;
  to_addresses: string[];
  /** Label-190001 payout metadata as returned by Koios, when present. */
  payout_meta: unknown | null;
  /** Another treasury of the community among the recipients (display only). */
  to_treasury_id: string | null;
  /** Chain import state (migration 0045); null = not evaluated yet. */
  import_status: ChainImportStatus | null;
  /** Why the import is held, when `import_status` is 'blocked'. */
  import_issues: ChainImportIssue[];
  /** When the sweep announced the spend to the governance channel, or decided not to (0059). */
  governance_alerted_at: string | null;
  created_at: string;
}
export const EXTERNAL_TX_COLUMNS =
  "tx_hash, treasury_id, block_height, block_time, fee_lovelace, amount_lovelace, assets, to_addresses, payout_meta, to_treasury_id, import_status, import_issues, governance_alerted_at, created_at";

/** One step of a workgroup's dated wallet routing (migration 0035). */
export interface WorkgroupTreasuryAssignmentRow {
  id: string;
  workgroup_id: string;
  /** Null = any community wallet. */
  treasury_id: string | null;
  /** "YYYY-MM-DD", the first of a month. */
  starts_on: string;
  reason: string | null;
  created_by: string;
  created_at: string;
}

export interface BoardColumnRow {
  id: string;
  name: string;
  position: number;
  /** Dropping a native task here makes it payable ("Audited"). */
  marks_payable: boolean;
  /** The confirm poller parks paid tasks here; nothing else writes into it. */
  marks_paid: boolean;
}

/**
 * One assignee of a task. 'github' rows mirror the issue's assignee list
 * (owned by the sync; the wallet is filled from the linked contributor only
 * while null); 'manual' rows are written by managers through
 * /api/tasks/assignees. Every assignee is paid the task's full amounts.
 */
export interface TaskAssigneeRow {
  id: string;
  task_id: string;
  source: "github" | "manual";
  gh_login: string | null;
  /** Immutable GitHub user id; null until the sync writes it (login alone is unverified). */
  gh_user_id: number | null;
  wallet_address: string | null;
  position: number;
}

/** An assignee as embedded on a task, with the contributor's display profile. */
export type TaskAssignee = Omit<TaskAssigneeRow, "task_id"> & {
  contributors?: ContributorProfile | null;
};

export const TASK_ASSIGNEE_COLUMNS = "id, source, gh_login, gh_user_id, wallet_address, position";
/** Embed for task selects; the contributor join is a left join (null while unlinked). */
export const TASK_ASSIGNEES_EMBED = `task_assignees(${TASK_ASSIGNEE_COLUMNS}, contributors(handle, github_username))`;

/** tasks columns the board/payday pages read (matches BoardTask). */
export const BOARD_TASK_COLUMNS = `id, number, title, body, source, column_id, bounty_lovelace, amounts, pay_state, archived_at, budget_month, paid_tx_hash, chain_number, gh_url, gh_status, gh_labels, gh_node_id, gh_repo_id, gh_issue_number, ${TASK_ASSIGNEES_EMBED}`;

export interface GithubInstallationRow {
  installation_id: number;
  community_id: string;
  account_login: string;
  account_type: string | null;
}

export interface GithubRepoRow {
  id: number;
  installation_id: number;
  full_name: string;
  workgroup_id: string | null;
  payable_label: string;
  import_status: string;
  /** Projects v2 Status option paid issues are moved to; "" disables the move. */
  paid_status: string;
}

export const REPO_LINK_COLUMNS =
  "id, installation_id, full_name, workgroup_id, payable_label, import_status, paid_status";

/** A wallet's verified Discord / Google account. Only the wallet itself reads it. */
export interface ContributorIdentityRow {
  wallet_address: string;
  provider: IdentityProvider;
  external_id: string;
  /** The provider's name for the account; Google (openid only) has none. */
  display_name: string | null;
  verified_at: string;
}

/**
 * A rewarded call. Finalizing it turns the attendees that have a wallet into
 * native tasks in `workgroup_id` (finalize_call, migration 0037); `amounts`
 * is the reward per attendee, in the tasks.amounts shape.
 */
export interface CallRow {
  id: string;
  community_id: string;
  workgroup_id: string;
  provider: CallProvider;
  title: string;
  external_ref: string | null;
  starts_at: string;
  ends_at: string;
  amounts: Record<string, string>;
  min_snapshots: number;
  min_minutes: number;
  /** When the ended call's participant report was read (Zoom / Meet). */
  captured_at: string | null;
  /** The linked meeting this call was created from automatically; null = created by hand. */
  meeting_link_id: string | null;
  state: CallState;
  created_by: string;
  created_at: string;
}

export const CALL_COLUMNS =
  "id, community_id, workgroup_id, provider, title, external_ref, starts_at, ends_at, amounts, min_snapshots, min_minutes, captured_at, meeting_link_id, state, created_by, created_at";

/** A recurring meeting tied to the workgroup that rewards it (migration 0043): its calls create themselves. */
export interface CallMeetingLinkRow {
  id: string;
  community_id: string;
  workgroup_id: string;
  /** The platform of the calls it creates (migration 0044 added Meet). */
  provider: "zoom" | "meet";
  /** A Zoom meeting id, or a Meet code. */
  meeting_ref: string;
  title: string;
  amounts: Record<string, string>;
  min_minutes: number;
  /** Length of a created call until the meeting itself says when it ended. */
  duration_minutes: number;
  created_by: string;
  created_at: string;
}

export const CALL_MEETING_LINK_COLUMNS =
  "id, community_id, workgroup_id, provider, meeting_ref, title, amounts, min_minutes, duration_minutes, created_by, created_at";

/**
 * One person on a call's list. A wallet appears once per call. The platform
 * account id (`external_id`) is deliberately not part of this shape: members
 * cannot select it (migration 0039) and only capture code writes it.
 */
export interface CallAttendeeRow {
  id: string;
  call_id: string;
  provider: AttendeeSource;
  display_name: string;
  wallet_address: string | null;
  snapshots_seen: number;
  minutes: number;
  first_seen: string | null;
  last_seen: string | null;
  status: AttendeeStatus;
  /** The attendance task that pays this attendee; null = not rewarded yet. */
  task_id: string | null;
  created_at: string;
}

/** An attendee as the call page reads it, with the contributor's display profile. */
export type CallAttendee = CallAttendeeRow & { contributors?: ContributorProfile | null };

export const CALL_ATTENDEE_COLUMNS =
  "id, call_id, provider, display_name, wallet_address, snapshots_seen, minutes, first_seen, last_seen, status, task_id, created_at";
export const CALL_ATTENDEES_EMBED = `${CALL_ATTENDEE_COLUMNS}, contributors(handle, github_username)`;

/**
 * A community's connection to a call platform (Discord: its server), as
 * members read it. The platform account id is deliberately not part of this
 * shape: members cannot select it (migration 0048); see CallIntegrationRecord.
 */
export interface CallIntegrationRow {
  id: string;
  community_id: string;
  provider: IntegrationProvider;
  label: string | null;
  created_by: string;
  created_at: string;
}

export const CALL_INTEGRATION_COLUMNS = "id, community_id, provider, label, created_by, created_at";

/** The full row, service role only. */
export interface CallIntegrationRecord extends CallIntegrationRow {
  /** Discord: the guild id. Zoom: the account id. Google: the host's OpenID sub. */
  external_account_id: string;
}

export const CALL_INTEGRATION_RECORD_COLUMNS = `${CALL_INTEGRATION_COLUMNS}, external_account_id`;

/** One capture of who was in a call's voice channel. */
export interface CallSnapshotRow {
  id: string;
  call_id: string;
  taken_at: string;
  source: "manual" | "cron";
}

/** An attendance task of a call, with what the call page shows of it. */
export interface CallTaskLink {
  task_id: string;
  chunk_index: number;
  tasks: { number: number; title: string; pay_state: string; paid_tx_hash: string | null } | null;
}

export const CALL_TASKS_EMBED = "task_id, chunk_index, tasks(number, title, pay_state, paid_tx_hash)";

/** A wallet a community paid from before Treasury Guild (migration 0050). The address is a label, never read. */
export interface LegacyWalletRow {
  id: string;
  community_id: string;
  name: string;
  address: string | null;
  created_by: string;
  created_at: string;
}

export const LEGACY_WALLET_COLUMNS = "id, community_id, name, address, created_by, created_at";

/** One uploaded payment-history CSV. */
export interface LegacyImportRow {
  id: string;
  community_id: string;
  legacy_wallet_id: string;
  file_name: string;
  line_count: number;
  created_by: string;
  created_at: string;
}

export const LEGACY_IMPORT_COLUMNS = "id, community_id, legacy_wallet_id, file_name, line_count, created_by, created_at";

/** One token amount of an imported line; `amount` is selected as text (base units, exact). */
export interface LegacyAmountRow {
  unit: string;
  ticker: string;
  decimals: number;
  amount: string;
}

export const LEGACY_AMOUNT_COLUMNS = "unit, ticker, decimals, amount::text";

/** One imported CSV line. */
export interface LegacyPaymentRow {
  id: string;
  import_id: string;
  community_id: string;
  legacy_wallet_id: string;
  workgroup_id: string;
  recipient_ref: string;
  task: string;
  paid_on: string;
  budget_month: string;
  line_no: number;
}

export const LEGACY_PAYMENT_COLUMNS =
  "id, import_id, community_id, legacy_wallet_id, workgroup_id, recipient_ref, task, paid_on, budget_month, line_no";

/** A planned amount of a funding commitment, in base units (the budget amount shape). */
export interface FundingAmount {
  unit: string;
  amount: string;
  asset_label: string | null;
  decimals: number;
}

/** An outside funder of a community (migration 0052). */
export interface FundingSourceRow {
  id: string;
  community_id: string;
  name: string;
  description: string | null;
  url: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const FUNDING_SOURCE_COLUMNS = "id, community_id, name, description, url, created_by, created_at, updated_at";

export type FundingCommitmentKind = "one_off" | "recurring" | "schedule";

/** What a source committed: a one-off total, a recurring amount, or a schedule of periods. */
export interface FundingCommitmentRow {
  id: string;
  source_id: string;
  community_id: string;
  name: string;
  url: string | null;
  note: string | null;
  kind: FundingCommitmentKind;
  cadence: "monthly" | "quarterly" | null;
  /** Day 1: a recurring commitment's first period, or a one-off's expected month. */
  starts_on: string | null;
  /** Day 1: a recurring commitment's last period; null = open-ended. */
  ends_on: string | null;
  /** Per period for recurring, the total for a one-off, empty for a schedule. */
  amounts: FundingAmount[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const FUNDING_COMMITMENT_COLUMNS =
  "id, source_id, community_id, name, url, note, kind, cadence, starts_on, ends_on, amounts, created_by, created_at, updated_at";

/** One period of a schedule commitment. */
export interface FundingPeriodRow {
  commitment_id: string;
  starts_on: string;
  amounts: FundingAmount[];
}

export const FUNDING_PERIOD_COLUMNS = "commitment_id, starts_on, amounts";

// --- Agent API authorization server (migration 0053, service role only) ---

export interface OAuthClientRow {
  client_id: string;
  is_metadata_url: boolean;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: "none" | "client_secret_post";
  secret_hash: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface OAuthGrantRow {
  wallet_address: string;
  client_id: string;
  scopes: string[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface OAuthCodeRow {
  code_hash: string;
  client_id: string;
  wallet_address: string;
  scopes: string[];
  resource: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface OAuthRefreshTokenRow {
  id: string;
  token_hash: string;
  client_id: string;
  wallet_address: string;
  scopes: string[];
  resource: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
}

// --- Governance (migration 0055) ------------------------------------------------

/** One proposal kind's settings; a missing row means the kind is off (defaults in governance/rules.ts). */
export interface GovernanceSettingsRow {
  community_id: string;
  kind: ProposalKind;
  enabled: boolean;
  proposers: Proposers;
  electorate: Electorate;
  activity_months: number;
  min_member_days: number;
  method: DecisionMethod;
  quorum_pct: number;
  threshold_pct: number;
  lazy_objections: number;
  lazy_cap_lovelace: string | null;
  escalate_method: DecisionMethod | null;
  discussion_hours: number;
  voting_hours: number;
  hide_results: boolean;
  recuse_beneficiaries: boolean;
  updated_by: string;
  updated_at: string;
}

export const GOVERNANCE_SETTINGS_COLUMNS =
  "community_id, kind, enabled, proposers, electorate, activity_months, min_member_days, method, quorum_pct, threshold_pct, lazy_objections, lazy_cap_lovelace, escalate_method, discussion_hours, voting_hours, hide_results, recuse_beneficiaries, updated_by, updated_at";

/** The `kind` of a change to the community-level settings (governance_community_settings). */
export const COMMUNITY_SETTINGS_KIND = "community";

export interface GovernanceSettingChangeRow {
  id: string;
  community_id: string;
  kind: ProposalKind | typeof COMMUNITY_SETTINGS_KIND;
  actor: string;
  before_value: GovernanceSettingsRow | GovernanceCommunitySettingsRow | null;
  after_value: GovernanceSettingsRow | GovernanceCommunitySettingsRow;
  changed_at: string;
}

export const GOVERNANCE_SETTING_CHANGE_COLUMNS = "id, community_id, kind, actor, before_value, after_value, changed_at";

/** Where frozen tally documents are published (proposal_document_copies.store). */
export type DocumentStoreName = "ipfs" | "github";

/** One row per community (0059 / 0067); a missing row = no publication, warn on a failed budget check. */
export interface GovernanceCommunitySettingsRow {
  community_id: string;
  document_store: DocumentStoreName | null;
  document_store_since: string | null;
  /** GitHub archive repo id when document_store is github (0067). */
  document_archive_repo_id: number | null;
  document_archive_full_name: string | null;
  spend_check: "warn" | "refuse";
  updated_by: string;
  updated_at: string;
}

export const GOVERNANCE_COMMUNITY_SETTINGS_COLUMNS =
  "community_id, document_store, document_store_since, document_archive_repo_id, document_archive_full_name, spend_check, updated_by, updated_at";

/** A proposal's frozen tally document (0059): the exact canonical JSON that was hashed. */
export interface ProposalTallyDocumentRow {
  proposal_id: string;
  community_id: string;
  document: string;
  hash: string;
  frozen_at: string;
}

export const PROPOSAL_TALLY_DOCUMENT_COLUMNS = "proposal_id, community_id, document, hash, frozen_at";

/** One copy of a frozen document in an outside store. */
export interface ProposalDocumentCopyRow {
  id: string;
  proposal_id: string;
  community_id: string;
  store: DocumentStoreName;
  locator: string;
  stored_at: string;
  last_checked_at: string;
}

export const PROPOSAL_DOCUMENT_COPY_COLUMNS = "id, proposal_id, community_id, store, locator, stored_at, last_checked_at";

export interface ProposalRow {
  id: string;
  community_id: string;
  /** Per community, from 1. */
  number: number;
  kind: ProposalKind;
  state: ProposalState;
  title: string;
  body: string;
  discussion_url: string | null;
  /** Discord thread/forum post id for discussion (0071); not in content_hash. */
  discord_thread_id: string | null;
  /** https://discord.com/channels/{guild}/{thread} when a discussion thread exists (0071). */
  discord_discussion_url: string | null;
  payload: ProposalPayload;
  content_hash: string;
  /** Frozen at creation: what this proposal is decided by. */
  rules: ProposalRules;
  rules_hash: string;
  workgroup_ids: string[];
  beneficiaries: string[];
  proposer: string;
  created_at: string;
  voting_starts_at: string;
  voting_opened_at: string | null;
  closes_at: string | null;
  closed_at: string | null;
  electorate_size: number | null;
  ballots_cast: number;
  ballot_version: number;
  tally: ProposalTally | null;
  outcome_reason: string | null;
  execution_state: ExecutionState | null;
  execution_error: string | null;
  /** What a passed workgroup or task proposal created: { workgroupId } / { taskId, workgroupId }. */
  execution_result: { workgroupId?: string; taskId?: string } | null;
  executed_at: string | null;
  ended_by: string | null;
  end_reason: string | null;
  /** The last milestone announced on the community's Discord (0057). */
  discord_milestone: "discussion" | "voting" | "reminder" | "closed" | null;
  /** sha256 of the voter list, set when voting opened (0060); every ballot signs it. Null before, and for proposals opened earlier. */
  electorate_hash: string | null;
  /** Whether its steps are ever due on-chain: false for proposals already final when anchoring shipped (0060). */
  anchored: boolean;
  /** The discussion proposal this one revised (0068); null when it is not a revision. */
  replaces_proposal_id: string | null;
}

export const PROPOSAL_COLUMNS =
  "id, community_id, number, kind, state, title, body, discussion_url, discord_thread_id, discord_discussion_url, payload, content_hash, rules, rules_hash, workgroup_ids, beneficiaries, proposer, created_at, voting_starts_at, voting_opened_at, closes_at, closed_at, electorate_size, ballots_cast, ballot_version, tally, outcome_reason, execution_state, execution_error, execution_result, executed_at, ended_by, end_reason, discord_milestone, electorate_hash, anchored, replaces_proposal_id";

/** Discord channel type stored on governance_discord_channels (0071). */
export type GovernanceDiscordChannelType = 0 | 5 | 15;

export interface GovernanceDiscordChannelRow {
  community_id: string;
  channel_id: string;
  channel_type: GovernanceDiscordChannelType;
  created_by: string;
  created_at: string;
  last_posted_at: string | null;
  last_error: string | null;
}

export const GOVERNANCE_DISCORD_CHANNEL_COLUMNS =
  "community_id, channel_id, channel_type, created_by, created_at, last_posted_at, last_error";

/** Text or announcement channel on a treasury Discord destination (0072). */
export type TreasuryDiscordChannelType = 0 | 5;

/**
 * One destination per treasury: either a pasted webhook URL or a bot channel
 * (migration 0072). The URL is a bearer secret — never send it to the browser.
 */
export interface TreasuryDiscordDestinationRow {
  treasury_id: string;
  url: string | null;
  channel_id: string | null;
  channel_type: TreasuryDiscordChannelType | null;
  created_by: string;
  created_at: string;
  last_posted_at: string | null;
  last_error: string | null;
}

export const TREASURY_DISCORD_DESTINATION_COLUMNS =
  "treasury_id, url, channel_id, channel_type, created_by, created_at, last_posted_at, last_error";

/** One step of a proposal carried by one transaction (0060). */
export interface ProposalAnchorRow {
  proposal_id: string;
  step: AnchorStep;
  transaction_id: string;
  created_at: string;
}

export const PROPOSAL_ANCHOR_COLUMNS = "proposal_id, step, transaction_id, created_at";

/** What the transaction of an anchor says about the step: its state and, once confirmed, when it landed. */
export type AnchorTransaction = Pick<TransactionRow, "id" | "state" | "tx_hash" | "block_time">;

/** An anchor row with its transaction embedded (member-readable: transactions_read). */
export type ProposalAnchorWithTx = ProposalAnchorRow & { transactions: AnchorTransaction | AnchorTransaction[] | null };

export const PROPOSAL_ANCHOR_WITH_TX_COLUMNS = `${PROPOSAL_ANCHOR_COLUMNS}, transactions(id, state, tx_hash, block_time)`;

export interface ProposalBudgetOwnerRow {
  proposal_id: string;
  workgroup_id: string | null;
  treasury_id: string | null;
  owner_key: string;
  base_revision: number;
  active: boolean;
}

export const PROPOSAL_BUDGET_OWNER_COLUMNS = "proposal_id, workgroup_id, treasury_id, owner_key, base_revision, active";

export interface ProposalVoterRow {
  proposal_id: string;
  wallet_address: string;
  recused: boolean;
}

export interface ProposalVoteRow {
  proposal_id: string;
  community_id: string;
  voter: string;
  choice: VoteChoice;
  reason: string | null;
  signed_at: string;
  signed_text: string;
  cose_key: string;
  cose_signature: string;
  created_at: string;
  updated_at: string;
}

export const PROPOSAL_VOTE_COLUMNS =
  "proposal_id, community_id, voter, choice, reason, signed_at, signed_text, cose_key, cose_signature, created_at, updated_at";

export type ProposalEventAction =
  | "created" | "voting_opened" | "closed" | "executed" | "execution_failed" | "withdrawn" | "cancelled";

export interface ProposalEventRow {
  id: string;
  proposal_id: string;
  community_id: string;
  action: ProposalEventAction;
  actor: string | null;
  detail: Record<string, unknown> | null;
  occurred_at: string;
}

export const PROPOSAL_EVENT_COLUMNS = "id, proposal_id, community_id, action, actor, detail, occurred_at";
