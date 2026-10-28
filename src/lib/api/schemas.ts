// Request schemas for the API routes. Isomorphic: routes parse with them and
// client hooks import the inferred body types. Checks that need DB state
// (e.g. "first treasury must include its creator") stay in the handlers.

import { z } from "zod";
import { LOVELACE } from "@/lib/assets";
import { rewardFromRows } from "@/lib/boardTypes";
import { isMeetingRef, MEET_CODE_ERROR, ZOOM_MEETING_ID_ERROR } from "@/lib/calls/meetingRef";
import { checkValidAddress } from "@/lib/cardano/multisigSDK";
import {
  AttendeeStatus, CallProvider, DecisionMethod, Electorate, LEGACY_MAX_CSV_CHARS, LEGACY_MAX_TICKERS, MAX_PASTED_ATTENDEES,
  MAX_PAYMENT_MEMO_BYTES, MAX_PAYOUT_CONTRIBUTORS, MAX_PROPOSAL_BODY, MAX_PROPOSAL_TITLE, MAX_TASK_ASSIGNEES,
  MAX_TREASURY_SIGNERS, MAX_VOTE_REASON, ProposalKind, Proposers, Role, SPENDING_PATHS, TREASURY_TEMPLATES, VoteChoice, Visibility,
} from "@/lib/constants";
import { MAX_BUDGET_STEPS } from "@/lib/governance/payload";
import { SpendCheckMode } from "@/lib/governance/rules";
import { CRON_JOB_IDS } from "@/lib/cron/jobs";
import { DISCORD_SCENARIO_IDS } from "@/lib/discord/fixtures";
import { errorMessage } from "@/lib/errors";

// --- Primitives ---------------------------------------------------------------

/** A row id (any well-formed UUID), so junk never reaches Postgres as a uuid cast. */
const id = z.guid();
/** Free text that is stored or echoed: bounded so a body cannot be arbitrarily large. */
const text = (max: number) => z.string().max(max);
const nonEmpty = z.string().trim().min(1);
export const walletAddress = z
  .string()
  .min(1)
  .max(200)
  .refine(checkValidAddress, "Invalid address");
/** A wallet the row already stores (no bech32 check, as removal must work for any stored value). */
const storedWallet = z.string().min(1).max(200);
const hex = z.string().max(200_000).regex(/^[0-9a-f]+$/i, "must be hex");
const txHash = z.string().regex(/^[0-9a-f]{64}$/i, "must be a 64-char hex hash");
/** Cardano network as stored on communities/treasuries: 0 = preprod, 1 = mainnet. */
export const network = z.union([z.literal(0), z.literal(1)]);

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** An app-relative path. Not "//…": URL parsing reads that as another host. */
export const SAFE_PATH_RE = /^\/(?!\/)[a-zA-Z0-9\-_/]*$/;

/** A requested return path when it is an app-relative path, else the fallback. */
export function safeReturnTo(requested: string | undefined, fallback: string): string {
  return requested && SAFE_PATH_RE.test(requested) ? requested : fallback;
}

export const IMAGE_MIME_RE = /^image\/[\w.+-]+$/;
export const HTTP_URL_RE = /^https?:\/\/\S+$/i;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_NFTS_PER_TX = 10;

// --- Auth ---------------------------------------------------------------------

export const authNonceSchema = z.object({ address: walletAddress });
export const authVerifySchema = z.object({
  address: storedWallet,
  /** The challenge text /api/auth/nonce issued and the wallet signed. */
  nonce: z.string().min(1).max(500),
  key: z.string().min(1).max(4000),
  signature: z.string().min(1).max(4000),
});

// --- Chain --------------------------------------------------------------------

// The address alone says which network to query (addr1… vs addr_test1…).
export const addressQuerySchema = z.object({ address: walletAddress });
// A tx hash carries no network, so the caller names it (query strings arrive as text).
export const txStatusQuerySchema = z.object({
  hash: txHash,
  network: z.coerce.number().pipe(network),
});

// --- Community / membership --------------------------------------------------

export const communityIdSchema = z.object({ communityId: id });
export const communityIdQuerySchema = communityIdSchema;

export const createCommunitySchema = z.object({
  slug: z
    .string()
    .regex(SLUG_RE, "Valid slug (lowercase, hyphens) required"),
  name: nonEmpty.max(100),
  description: z.string().trim().max(1000).optional(),
  // Chosen once: treasury addresses and on-chain history are bound to it.
  network,
  // Defaults private (same as the column default); changeable later on Members.
  visibility: z.enum([Visibility.Public, Visibility.Private]).default(Visibility.Private),
});

/** CoinGecko coin id as it appears in the coin's page URL ("cardano", "singularitynet"). */
export const COINGECKO_ID_RE = /^[a-z0-9-]{1,64}$/;
export const FIAT_CURRENCY_RE = /^[a-z]{3,5}$/;
/** A native asset unit as stored: policy id (56 hex) + asset name hex. */
export const ASSET_UNIT_RE = /^[0-9a-f]{56,120}$/;
/** "lovelace" or a native asset unit; the community's main spending token. */
export const spendingUnit = z
  .string()
  .trim()
  .toLowerCase()
  .refine((unit) => unit === LOVELACE || ASSET_UNIT_RE.test(unit), "Token unit: 'lovelace' or a policy id + asset name (hex)");

export const patchCommunitySchema = z
  .object({
    communityId: id,
    visibility: z.enum([Visibility.Public, Visibility.Private]).optional(),
    spendingUnit: spendingUnit.optional(),
    /** null = no exchange rate in Discord notifications (date only). */
    discordRateCoin: z
      .string()
      .trim()
      .toLowerCase()
      .regex(COINGECKO_ID_RE, "CoinGecko id: lowercase letters, digits and hyphens")
      .nullable()
      .optional(),
    discordRateCurrency: z
      .string()
      .trim()
      .toLowerCase()
      .regex(FIAT_CURRENCY_RE, "Currency code: 3 to 5 letters (usd, eur…)")
      .optional(),
  })
  .refine(
    (b) => b.visibility !== undefined || b.spendingUnit !== undefined ||
      b.discordRateCoin !== undefined || b.discordRateCurrency !== undefined,
    { message: "Nothing to update" },
  );

export const registerContributorSchema = z.object({ address: walletAddress });

export const memberAddSchema = z.object({
  communityId: id,
  wallet: walletAddress,
});
export const memberPatchSchema = z.object({
  communityId: id,
  wallet: storedWallet,
  role: z.enum([Role.Admin, Role.Member]),
});
export const memberDeleteSchema = z.object({
  communityId: id,
  wallet: storedWallet,
});

/** Opaque invite token in the URL path (32-byte base64url). */
export const inviteTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Invalid invite link");

export const createInviteSchema = z.object({
  communityId: id,
  /** Days until expiry; null = never. Default 30 when omitted. */
  expiresInDays: z
    .union([z.literal(7), z.literal(30), z.literal(90), z.null()])
    .optional()
    .default(30),
  /** null / omitted = unlimited. */
  maxUses: z.number().int().min(1).max(10_000).nullable().optional().default(null),
  label: z.string().trim().min(1).max(100).nullable().optional().default(null),
});
export const revokeInviteSchema = z.object({
  communityId: id,
  inviteId: id,
});

export const workgroupLeadAddSchema = z.object({
  workgroupId: id,
  wallet: walletAddress,
});
export const workgroupLeadDeleteSchema = z.object({
  workgroupId: id,
  wallet: storedWallet,
});

// --- Tasks --------------------------------------------------------------------

/**
 * One assignee as the task editor submits it. GitHub rows are identified by
 * id (their login is managed on GitHub) and may have their payout wallet set
 * or cleared; manual rows always carry a wallet.
 */
export const taskAssigneeInputSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("github"),
    id: z.uuid(),
    wallet: walletAddress.nullable(),
  }),
  z.object({ source: z.literal("manual"), wallet: walletAddress }),
]);
export const setTaskAssigneesSchema = z
  .object({
    taskId: z.uuid(),
    assignees: z.array(taskAssigneeInputSchema).max(MAX_TASK_ASSIGNEES),
  })
  .superRefine((body, ctx) => {
    // A wallet listed twice would be paid twice.
    const seen = new Set<string>();
    body.assignees.forEach((a, index) => {
      if (!a.wallet) return;
      if (seen.has(a.wallet)) {
        ctx.addIssue({
          code: "custom",
          path: ["assignees", index, "wallet"],
          message: "Each wallet can be assigned once",
        });
      }
      seen.add(a.wallet);
    });
  });

// --- Treasury -----------------------------------------------------------------

export const treasuryImportSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cbor"), cbor: z.string().min(1).max(65_536) }),
]);

export const previewTreasuryImportSchema = z.object({
  communityId: id,
  source: treasuryImportSourceSchema,
});

const treasurySignerInput = z.object({ address: storedWallet, name: text(100).optional() });
const treasurySigners = z.array(treasurySignerInput).min(1).max(MAX_TREASURY_SIGNERS);

export const createTreasurySchema = z.object({
  communityId: id,
  name: nonEmpty.max(100),
  /** The base group's threshold (atLeast). */
  required: z.number().int().min(0).max(MAX_TREASURY_SIGNERS).optional(),
  /** The base group's rule. */
  scriptType: z.enum(["all", "any", "atLeast"]).default("atLeast"),
  /** The base signers; with `source`, every signer of the script in any group. */
  signers: treasurySigners,
  /** The workgroup this wallet pays; absent or null = a community treasury. */
  workgroupId: z.uuid().nullable().optional(),
  source: treasuryImportSourceSchema.optional(),
  /** The script template (src/lib/cardano/templates.ts); a `source` overrides it with what the CBOR says. */
  template: z.enum(TREASURY_TEMPLATES).default("plain"),
  /** Clawback and lock-until: the lock date (ISO), at least an hour ahead. */
  lockUntil: z.string().max(40).optional(),
  /** Clawback: the recovery group. */
  recovery: z.object({
    scriptType: z.enum(["all", "any", "atLeast"]).default("any"),
    required: z.number().int().min(0).max(MAX_TREASURY_SIGNERS).optional(),
    signers: treasurySigners,
  }).optional(),
  /** Cosigner: a member's wallet, or a key the app generates and keeps. */
  cosigner: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("member"), address: storedWallet }),
    z.object({ kind: z.literal("app") }),
  ]).optional(),
}).superRefine((body, ctx) => {
  if (body.source) return; // the CBOR decides the template and its groups
  const needsLock = body.template === "clawback" || body.template === "lock_until";
  if (needsLock && !body.lockUntil) ctx.addIssue({ code: "custom", path: ["lockUntil"], message: "Choose the lock date" });
  if (!needsLock && body.lockUntil) ctx.addIssue({ code: "custom", path: ["lockUntil"], message: "Only a clawback or lock-until treasury has a lock date" });
  if (body.template === "clawback" && !body.recovery) ctx.addIssue({ code: "custom", path: ["recovery"], message: "Add the recovery signers" });
  if (body.template !== "clawback" && body.recovery) ctx.addIssue({ code: "custom", path: ["recovery"], message: "Only a clawback treasury has recovery signers" });
  if (body.template === "cosigner" && !body.cosigner) ctx.addIssue({ code: "custom", path: ["cosigner"], message: "Choose the co-signer" });
  if (body.template !== "cosigner" && body.cosigner) ctx.addIssue({ code: "custom", path: ["cosigner"], message: "Only a co-signer treasury has a co-signer" });
});

/** Discord incoming-webhook URL (discord.com, discordapp.com, ptb/canary). */
export const DISCORD_WEBHOOK_URL_RE =
  /^https:\/\/(ptb\.|canary\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
export const discordWebhookUrl = z
  .string()
  .trim()
  .regex(DISCORD_WEBHOOK_URL_RE, "Must be a Discord webhook URL (https://discord.com/api/webhooks/…)");

/** GET /api/treasury: the details dialog. */
export const treasuryIdQuerySchema = z.object({ treasuryId: id });

/** POST /api/treasury/primary: which wallet's base signers are community admins. */
export const setPrimaryTreasurySchema = z.object({
  communityId: id,
  treasuryId: id,
});

const discordChannelId = z.string().trim().min(1).max(32).regex(/^\d+$/);

/** POST /api/treasury/discord: webhook URL or bot channel (XOR). */
export const setTreasuryDiscordDestinationSchema = z.union([
  z.object({ treasuryId: id, url: discordWebhookUrl }).strict(),
  z.object({ treasuryId: id, channelId: discordChannelId }).strict(),
]);
export const deleteTreasuryDiscordDestinationSchema = z.object({ treasuryId: id });
/** The community's governance Discord channel (Governance settings). */
export const setGovernanceDiscordChannelSchema = z.object({
  communityId: id,
  channelId: discordChannelId,
});

// --- Developer tools ----------------------------------------------------------

/** /api/dev/discord: post one fixture scenario to a webhook. */
export const devDiscordSendSchema = z.object({
  url: discordWebhookUrl,
  scenario: z.enum(DISCORD_SCENARIO_IDS),
});

/** /api/dev/cron: run one scheduled job now. */
export const devCronRunSchema = z.object({
  job: z.enum(CRON_JOB_IDS),
});

/** /api/dev/anchor-test: build a metadata-only test transaction from a treasury. */
/** The spending path a build takes; absent = the template's default (src/lib/cardano/spendingPaths.ts). */
const spendingPath = z.enum(SPENDING_PATHS).optional();

export const devAnchorTestSchema = z.object({ treasuryId: id, path: spendingPath });

/** /api/tx/build-anchor: the treasury that pays the fee of a dedicated anchor transaction. */
export const buildAnchorSchema = z.object({ treasuryId: id, path: spendingPath });

// --- Transactions -------------------------------------------------------------

export const signTxSchema = z.object({ signedPayloadHex: hex });

export const buildPayoutSchema = z.object({
  treasuryId: id,
  path: spendingPath,
  taskIds: z.array(id).min(1).max(200),
  /** Manual bounty-field -> wallet-token-unit connections from Payday. */
  connections: z
    .record(text(64), text(200))
    .refine((c) => Object.keys(c).length <= 100, "Too many token connections")
    .optional(),
});

/** Display-unit decimal string; the route scales it with the token's decimals. */
const displayAmount = z.string().trim().max(60).regex(/^\d+(?:\.\d+)?$/, "Enter a positive number");

export const buildPaymentSchema = z.object({
  treasuryId: id,
  path: spendingPath,
  /** Budget month the spend counts against ("YYYY-MM"); the route aligns it to the treasury's cadence. */
  budgetMonth: z.string().regex(/^(?:[1-9]\d{3})-(?:0[1-9]|1[0-2])$/, "Choose a valid month (YYYY-MM)"),
  memo: z.string().trim().max(MAX_PAYMENT_MEMO_BYTES, `Memo must be at most ${MAX_PAYMENT_MEMO_BYTES} characters`).optional(),
  /** A passed and applied budget proposal of the community the payment carries out (cited on-chain). */
  proposalId: id.optional(),
  /**
   * Empty the paying treasury into the single recipient: every held asset is
   * moved (ADA after the fee). Client amounts are ignored; the route reads
   * the wallet.
   */
  drain: z.boolean().optional(),
  recipients: z
    .array(z.object({
      address: walletAddress,
      /** unit ("lovelace" or policyId+assetNameHex) -> amount in display units. Empty when draining. */
      amounts: z
        .record(text(200), displayAmount)
        .refine((a) => Object.keys(a).length <= 50, "Too many tokens for one recipient")
        .default({}),
    }))
    .min(1, "Add at least one recipient")
    .max(MAX_PAYOUT_CONTRIBUTORS, `At most ${MAX_PAYOUT_CONTRIBUTORS} recipients per payment`),
}).superRefine((body, ctx) => {
  if (body.drain && body.recipients.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Move all assets pays one recipient",
      path: ["recipients"],
    });
  }
});

export const mintAssetInputSchema = z.object({
  name: text(200).optional(),
  description: text(2000).optional(),
  imageCid: text(200).optional(),
  mediaType: text(100).optional(),
  attributes: z
    .record(text(64), text(512))
    .refine((a) => Object.keys(a).length <= 50, "At most 50 attributes")
    .optional(),
});

export const mintPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("treasury") }),
  z.object({
    mode: z.literal("locked"),
    lockUntil: text(64).optional(),
    lockSlot: z.number().int().nonnegative().optional(),
  }),
]);

export const buildMintSchema = z.object({
  treasuryId: id,
  path: spendingPath,
  assetKind: z.enum(["ft", "nft"]),
  assets: z.array(mintAssetInputSchema).min(1, "At least one asset is required").max(100),
  /** Fungible only */
  ticker: text(32).optional(),
  decimals: z.number().int().min(0).max(12).optional(),
  supply: text(40).optional(),
  url: text(2000).optional(),
  recipient: text(200).optional(),
  policy: mintPolicySchema.optional(),
});

// --- Calls --------------------------------------------------------------------

/** A task's bounty (a call's reward per attendee), the tasks.amounts shape: ticker -> display-unit amount. */
const rewardAmounts = z.record(nonEmpty, displayAmount).superRefine((amounts, ctx) => {
  try {
    rewardFromRows(Object.entries(amounts).map(([ticker, amount]) => ({ ticker, amount })));
  } catch (err) {
    ctx.addIssue({ code: "custom", message: errorMessage(err, "Invalid reward") });
  }
});
const callFields = {
  title: nonEmpty.max(120, "Title must be at most 120 characters"),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  amounts: rewardAmounts,
  /**
   * What the call is captured from: a Discord voice channel id, a Zoom
   * meeting id (digits) or a Meet code (abc-mnop-xyz). Null clears it; the
   * route checks it against the call's platform.
   */
  externalRef: z
    .string()
    .regex(/^(\d{9,22}|[a-z]{3}-[a-z]{4}-[a-z]{3})$/, "Enter a channel, a meeting ID or a Meet code")
    .nullable(),
  /** Presence threshold for captured attendees. */
  minSnapshots: z.number().int().min(0).max(100),
  minMinutes: z.number().int().min(0).max(24 * 60),
};
const endsAfterStart = (b: { startsAt?: string; endsAt?: string }) =>
  !b.startsAt || !b.endsAt || Date.parse(b.endsAt) > Date.parse(b.startsAt);

export const createCallSchema = z
  .object({
    workgroupId: z.uuid(),
    provider: z.enum([CallProvider.Discord, CallProvider.Zoom, CallProvider.Meet, CallProvider.Manual]),
    ...callFields,
    externalRef: callFields.externalRef.default(null),
    minSnapshots: callFields.minSnapshots.default(1),
    minMinutes: callFields.minMinutes.default(0),
  })
  .refine(endsAfterStart, { path: ["endsAt"], message: "The call must end after it starts" });

/** Start and end change together so the pair stays ordered. */
export const patchCallSchema = z
  .object(callFields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" })
  .refine((b) => (b.startsAt === undefined) === (b.endsAt === undefined), {
    path: ["endsAt"],
    message: "Set the start and the end together",
  })
  .refine(endsAfterStart, { path: ["endsAt"], message: "The call must end after it starts" });

/** A recurring Zoom or Meet meeting whose calls create themselves in a workgroup. */
const meetingLinkFields = {
  title: callFields.title,
  amounts: rewardAmounts,
  minMinutes: callFields.minMinutes,
  /** Length of a created call until the meeting itself says when it ended. */
  durationMinutes: z.number().int().min(1).max(24 * 60),
};
export const createMeetingLinkSchema = z
  .object({
    workgroupId: z.uuid(),
    provider: z.enum([CallProvider.Zoom, CallProvider.Meet]).default(CallProvider.Zoom),
    /** A Zoom meeting id (digits) or a Meet code (abc-mnop-xyz), already normalised. */
    meetingRef: z.string().max(64),
    ...meetingLinkFields,
    minMinutes: meetingLinkFields.minMinutes.default(0),
    durationMinutes: meetingLinkFields.durationMinutes.default(60),
  })
  .refine((b) => b.provider !== CallProvider.Zoom || isMeetingRef("zoom", b.meetingRef), {
    path: ["meetingRef"],
    message: ZOOM_MEETING_ID_ERROR,
  })
  .refine((b) => b.provider !== CallProvider.Meet || isMeetingRef("meet", b.meetingRef), {
    path: ["meetingRef"],
    message: MEET_CODE_ERROR,
  });
export const patchMeetingLinkSchema = z
  .object(meetingLinkFields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to update" });

export const addAttendeesSchema = z.discriminatedUnion("kind", [
  /** A pasted participant list: one display name per entry. */
  z.object({
    kind: z.literal("names"),
    names: z
      .array(nonEmpty.max(100))
      .min(1, "Paste at least one name")
      .max(MAX_PASTED_ATTENDEES, `At most ${MAX_PASTED_ATTENDEES} names at a time`),
  }),
  z.object({ kind: z.literal("wallet"), wallet: walletAddress }),
]);

export const patchAttendeeSchema = z
  .object({
    attendeeId: z.uuid(),
    /** null unlinks. */
    wallet: walletAddress.nullable().optional(),
    /** Remember name -> wallet for the community's next calls. */
    remember: z.boolean().default(false),
    status: z.enum([AttendeeStatus.Auto, AttendeeStatus.Confirmed, AttendeeStatus.Excluded]).optional(),
  })
  .refine((b) => b.wallet !== undefined || b.status !== undefined, { message: "Nothing to update" });

export const deleteAttendeeSchema = z.object({ attendeeId: z.uuid() });

export const callCheckinSchema = z.object({ code: nonEmpty.max(32) });

/** GET /api/discord/guild-connect: add the capture bot to the community's server. */
export const guildConnectQuerySchema = z.object({ communityId: z.uuid(), returnTo: text(200).optional() });
export const guildDisconnectSchema = z.object({ communityId: z.uuid() });

// --- Reconciliation -----------------------------------------------------------

export const reconcileMatchQuerySchema = z.object({ txHash });
export const reconcileMatchSchema = z.object({
  txHash,
  payoutId: id.nullable().optional(),
  amount: z.string().regex(/^\d{1,30}$/, "Amount must be a whole base-unit quantity"),
  unit: text(120).optional(),
  note: text(500).optional(),
});

export const incomingDetailsSchema = z.object({
  txHash,
  incomingType: z.enum([
    "unclassified",
    "refund",
    "contribution",
    "revenue",
    "transfer",
    "other",
  ]),
  requiresReconciliation: z.boolean(),
  note: z.string().trim().max(1000).optional(),
  /** The funding source (and commitment) the whole inflow came from; null clears it. */
  fundingSourceId: id.nullable().optional(),
  fundingCommitmentId: id.nullable().optional(),
}).refine((v) => !v.fundingCommitmentId || !!v.fundingSourceId, "Choose the funding source of the commitment");

// --- Funding sources ------------------------------------------------------------

const optionalUrl = z.string().trim().max(500).regex(HTTP_URL_RE, "Use a link starting with http:// or https://")
  .nullable().optional().or(z.literal("").transform(() => null));
const fundingMonth = z.string().regex(/^(?:[1-9]\d{3})-(?:0[1-9]|1[0-2])$/, "Choose a valid month (YYYY-MM)");
const quarterMonth = (month: string) => ["01", "04", "07", "10"].includes(month.slice(5));
/** A planned amount in display units ("20000", "211800.72389063"); scaled on the server. */
const fundingAmountInput = z.object({
  unit: z.string().trim().toLowerCase()
    .refine((unit) => unit === LOVELACE || ASSET_UNIT_RE.test(unit), "Token unit: 'lovelace' or a policy id + asset name (hex)"),
  amount: z.string().trim().regex(/^\d+(\.\d+)?$/, "Enter amounts as plain numbers with a dot for decimals")
    .refine((amount) => /[1-9]/.test(amount), "Amounts must be above zero"),
});
const fundingAmountsInput = z.array(fundingAmountInput).min(1, "Add at least one token").max(20)
  .refine((rows) => new Set(rows.map((r) => r.unit)).size === rows.length, "List each token once");

export const fundingSourceSchema = z.object({
  communityId: id,
  name: nonEmpty.max(80),
  description: z.string().trim().max(500).nullable().optional(),
  url: optionalUrl,
});
export const patchFundingSourceSchema = fundingSourceSchema.omit({ communityId: true }).partial();
export const deleteFundingSourceSchema = z.object({ confirmName: z.string().max(80) });

export const fundingCommitmentSchema = z.object({
  sourceId: id,
  name: nonEmpty.max(120),
  url: optionalUrl,
  note: z.string().trim().max(500).nullable().optional(),
  kind: z.enum(["one_off", "recurring", "schedule"]),
  cadence: z.enum(["monthly", "quarterly"]).nullable().optional(),
  /** Recurring: the first period; one-off: the expected month (optional). */
  startsOn: fundingMonth.nullable().optional(),
  /** Recurring: the last period; null = open-ended. */
  endsOn: fundingMonth.nullable().optional(),
  /** Per period for recurring, the total for a one-off; none for a schedule. */
  amounts: z.array(fundingAmountInput).max(20).default([]),
}).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if ((v.kind === "one_off") !== !v.cadence) issue(v.kind === "one_off" ? "A one-off commitment has no cadence" : "Choose monthly or quarterly");
  if (v.kind === "recurring" && !v.startsOn) issue("Choose the first month");
  if (v.kind !== "recurring" && v.endsOn) issue("Only a recurring commitment has an end month");
  if (v.kind === "schedule" && (v.startsOn || v.amounts.length > 0)) issue("A schedule's amounts are set per period");
  if (v.kind !== "schedule") {
    const parsed = fundingAmountsInput.safeParse(v.amounts);
    if (!parsed.success) issue(parsed.error.issues[0]?.message ?? "Invalid amounts");
  }
  if (v.startsOn && v.endsOn && v.endsOn < v.startsOn) issue("The last month comes before the first");
  if (v.cadence === "quarterly" && [v.startsOn, v.endsOn].some((m) => m && !quarterMonth(m))) {
    issue("Quarterly periods start in January, April, July or October");
  }
});
export const patchFundingCommitmentSchema = z.object({
  name: nonEmpty.max(120).optional(),
  url: optionalUrl,
  note: z.string().trim().max(500).nullable().optional(),
  startsOn: fundingMonth.nullable().optional(),
  endsOn: fundingMonth.nullable().optional(),
  amounts: fundingAmountsInput.optional(),
});
export const fundingScheduleSchema = z.object({
  periods: z.array(z.object({ month: fundingMonth, amounts: fundingAmountsInput })).max(600)
    .refine((periods) => new Set(periods.map((p) => p.month)).size === periods.length, "Each month appears once"),
});

// --- Chain import ---------------------------------------------------------------

/**
 * Settle a workgroup name the on-chain record uses: create a workgroup with
 * that name, or point the name at an existing one. `name` is the metadata's
 * (possibly truncated) string, at most one metadatum.
 */
export const chainImportWorkgroupSchema = z
  .object({
    communityId: id,
    name: nonEmpty.max(64),
    action: z.enum(["create", "map"]),
    workgroupId: id.optional(),
  })
  .refine((v) => v.action !== "map" || !!v.workgroupId, "Choose a workgroup");

export const chainImportResolveSchema = z.object({
  txHash,
  action: z.enum(["retry", "new_number", "ignore", "unignore"]),
  /** For `new_number`: the chain task numbers to import under a new number. */
  chainNumbers: z.array(z.number().int().positive()).max(200).optional(),
});

// --- Payment history (previous wallets) --------------------------------------------

const legacyWalletName = nonEmpty.max(64);
/** A previous wallet's address: a label only, but a well-formed Shelley address. */
const legacyWalletAddress = walletAddress.refine((a) => /^addr(_test)?1/.test(a), "Use a Shelley address (addr1… or addr_test1…)");

export const createLegacyWalletSchema = z.object({
  communityId: id,
  name: legacyWalletName,
  address: legacyWalletAddress.nullable().optional(),
});
export const patchLegacyWalletSchema = z.object({
  name: legacyWalletName.optional(),
  address: legacyWalletAddress.nullable().optional(),
});
export const deleteLegacyWalletSchema = z.object({ confirmName: z.string().max(64) });

/**
 * Settle a workgroup name a history CSV uses: create a workgroup, or point
 * the (normalized) name at an existing one, archived ones included.
 */
export const legacyWorkgroupSchema = z
  .object({
    communityId: id,
    name: nonEmpty.max(64),
    action: z.enum(["create", "map"]),
    workgroupId: id.optional(),
    /** The name to create, when it differs from the normalized key. */
    displayName: nonEmpty.max(100).optional(),
  })
  .refine((v) => v.action !== "map" || !!v.workgroupId, "Choose a workgroup");

/** An uploaded CSV to preview or import; the server re-parses it every time. */
export const legacyUploadSchema = z.object({
  communityId: id,
  legacyWalletId: id,
  fileName: nonEmpty.max(255),
  csv: z.string().min(1).max(LEGACY_MAX_CSV_CHARS, "The file is larger than 1 MB. Split it into several files."),
  tickerUnits: z
    .record(z.string().min(1).max(32), z.string().regex(ASSET_UNIT_RE, "Token unit: a policy id + asset name (hex)"))
    .refine((m) => Object.keys(m).length <= LEGACY_MAX_TICKERS, "Too many token choices")
    .default({}),
  replaceImportId: id.nullable().optional(),
  includeDuplicates: z.boolean().default(false),
});

export const legacyOverviewQuerySchema = z.object({ communityId: id });
export const legacyRowsQuerySchema = z.object({
  communityId: id,
  importId: id.optional(),
  walletId: id.optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

// --- Budgets -----------------------------------------------------------------

const budgetMonthSchema = z.string().regex(
  /^(?:[1-9]\d{3})-(?:0[1-9]|1[0-2])$/,
  "Choose a valid month (YYYY-MM)",
);
export const budgetsQuerySchema = z.object({
  communityId: id,
  month: budgetMonthSchema.optional(),
  view: z.enum(["month", "quarter", "recurring"]).default("month"),
});
/**
 * The Dashboard has no recurring view: it compares spending to a dated
 * period, or to every period so far (`all`, which ignores `month`).
 */
export const dashboardQuerySchema = z.object({
  communityId: id,
  month: budgetMonthSchema.optional(),
  view: z.enum(["month", "quarter", "all"]).default("month"),
});
const budgetInputSchema = z.object({
  cadence: z.enum(["monthly", "quarterly"]),
  unit: nonEmpty.max(120),
  amount: z.string().regex(/^\d{1,30}$/, "Amount must be a whole base-unit quantity"),
});

export const upsertBudgetsSchema = z.object({
  /** The budget's owner: exactly one of a workgroup or a treasury (manual payments). */
  workgroupId: id.optional(),
  treasuryId: id.optional(),
  budgetMonth: budgetMonthSchema.nullable().default(null),
  budgetCadence: z.enum(["monthly", "quarterly"]).default("monthly"),
  budgets: z
    .array(budgetInputSchema)
    .max(50)
    .superRefine((budgets, ctx) => {
      const seen = new Set<string>();
      budgets.forEach((budget, index) => {
        if (seen.has(budget.unit)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "unit"],
            message: "Each token can only appear once per project",
          });
        }
        seen.add(budget.unit);
      });
    }),
}).superRefine((input, ctx) => {
  if ((input.workgroupId ? 1 : 0) + (input.treasuryId ? 1 : 0) !== 1) {
    ctx.addIssue({ code: "custom", path: ["workgroupId"], message: "Choose exactly one workgroup or treasury" });
  }
  if (input.budgetMonth && input.budgets.some((budget) => budget.cadence !== input.budgetCadence)) {
    ctx.addIssue({ code: "custom", path: ["budgets"], message: "Budget frequency must match the selected period" });
  }
  if (input.budgetMonth && input.budgetCadence === "quarterly" && !["01", "04", "07", "10"].includes(input.budgetMonth.slice(5))) {
    ctx.addIssue({ code: "custom", path: ["budgetMonth"], message: "Choose the first month of a calendar quarter" });
  }
});

export const saveBudgetSetupSchema = upsertBudgetsSchema.and(z.object({
  expectedRevision: z.number().int().nonnegative(),
  mode: z.enum(["recurring", "monthly", "quarterly"]),
  startsOn: budgetMonthSchema,
  confirmTransition: z.boolean().default(false),
  reason: z.string().trim().max(500).default(""),
})).superRefine((input, ctx) => {
  if ((input.mode !== "recurring" && input.mode !== input.budgetCadence) ||
    input.budgets.some((b) => b.cadence !== input.budgetCadence)) {
    ctx.addIssue({ code: "custom", path: ["budgetCadence"], message: "All tokens must use the workgroup's budget cadence" });
  }
  if (input.budgetCadence === "quarterly" && !["01", "04", "07", "10"].includes(input.startsOn.slice(5))) {
    ctx.addIssue({ code: "custom", path: ["startsOn"], message: "Choose a quarter boundary" });
  }
});

// --- Governance (proposals and voting) ------------------------------------------

/** One proposal kind's settings (governance/rules.ts GovernanceSettings). */
export const governanceSettingsInput = z.object({
  enabled: z.boolean(),
  proposers: z.enum(Proposers),
  electorate: z.enum(Electorate),
  activityMonths: z.number().int().min(1).max(36),
  minMemberDays: z.number().int().min(0).max(365),
  method: z.enum(DecisionMethod),
  quorumPct: z.number().int().min(0).max(100),
  thresholdPct: z.number().int().min(50).max(99),
  lazyObjections: z.number().int().min(1).max(50),
  lazyCapLovelace: z.string().regex(/^[1-9]\d{0,17}$/, "Enter the cap in lovelace").nullable(),
  escalateMethod: z.enum([DecisionMethod.Consent, DecisionMethod.Majority]).nullable(),
  discussionHours: z.number().int().min(0).max(336),
  votingHours: z.number().int().min(1).max(720),
  hideResults: z.boolean(),
  recuseBeneficiaries: z.boolean(),
});
/** The rules frozen onto one proposal (ProposalRules). Omitted on create: the kind's settings. */
export const proposalRulesInput = governanceSettingsInput.pick({
  method: true,
  electorate: true,
  activityMonths: true,
  minMemberDays: true,
  quorumPct: true,
  thresholdPct: true,
  lazyObjections: true,
  discussionHours: true,
  votingHours: true,
  hideResults: true,
  recuseBeneficiaries: true,
});
export const saveGovernanceSettingsSchema = z.object({
  communityId: id,
  kind: z.enum(ProposalKind),
  settings: governanceSettingsInput,
});
/** The community-level settings (governance_community_settings, 0059 / 0067): publication store and spending-check mode. */
export const saveGovernanceCommunitySettingsSchema = z.object({
  communityId: id,
  documentStore: z.enum(["ipfs", "github"]).nullable(),
  /** Required when documentStore is github; ignored otherwise (server clears it). */
  documentArchiveRepoId: z.number().int().positive().nullable().optional(),
  spendCheck: z.enum(SpendCheckMode),
}).superRefine((value, ctx) => {
  if (value.documentStore === "github" && value.documentArchiveRepoId == null) {
    ctx.addIssue({
      code: "custom",
      message: "Pick a GitHub archive repository",
      path: ["documentArchiveRepoId"],
    });
  }
});

const proposalText = {
  communityId: id,
  title: nonEmpty.max(MAX_PROPOSAL_TITLE),
  body: z.string().trim().max(MAX_PROPOSAL_BODY).default(""),
  discussionUrl: optionalUrl,
  /** This proposal's rules. Omit to freeze the community's defaults for the kind. */
  rules: proposalRulesInput.optional(),
  /**
   * Withdraw this discussion proposal in the same step and link the new one as
   * its revision (0068). Same proposer, community and kind; clock resets.
   */
  replacesProposalId: id.optional(),
};
export const createProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(ProposalKind.Decision), ...proposalText }),
  /** The saves the budget worksheet would have made, in order: applied together when the proposal passes. */
  z.object({
    kind: z.literal(ProposalKind.Budget),
    ...proposalText,
    saves: z.array(saveBudgetSetupSchema).min(1, "Change at least one budget").max(MAX_BUDGET_STEPS),
  }),
  /** A new native workgroup; its board starts with the default columns. */
  z.object({
    kind: z.literal(ProposalKind.Workgroup),
    ...proposalText,
    workgroup: z.object({
      name: nonEmpty.max(80),
      description: z.string().trim().max(1000).default(""),
      leads: z.array(storedWallet).max(10).default([]),
    }),
  }),
  /** A task on an app board: the proposal's title and text become the task's. */
  z.object({
    kind: z.literal(ProposalKind.Task),
    ...proposalText,
    task: z.object({
      workgroupId: id,
      amounts: rewardAmounts,
      assignSelf: z.boolean().default(false),
    }),
  }),
]);
const queryFlag = z.enum(["true", "false"]).optional()
  .transform((value): boolean | undefined => (value === undefined ? undefined : value === "true"));
export const electorateQuerySchema = z.object({
  communityId: id,
  kind: z.enum(ProposalKind),
  /** Comma-separated ids of the workgroups a proposal would concern. */
  workgroupIds: z.string().max(4000).optional()
    .transform((ids) => (ids ? ids.split(",").filter(Boolean) : []))
    .pipe(z.array(id).max(100)),
  /** The rules the create form is showing. Omitted: the kind's saved settings. */
  electorate: z.enum(Electorate).optional(),
  activityMonths: z.coerce.number().int().min(1).max(36).optional(),
  minMemberDays: z.coerce.number().int().min(0).max(365).optional(),
  /** Omitted: the kind's saved recusal. A budget's beneficiaries are its workgroups' leads, not this list. */
  recuseBeneficiaries: queryFlag,
  /** Wallets who gain from a decision, workgroup or task the form is making. Comma-separated. */
  beneficiaries: z.string().max(5000).optional()
    .transform((wallets) => (wallets ? wallets.split(",").filter(Boolean) : []))
    .pipe(z.array(storedWallet).max(20)),
});
const voteReason = z.string().max(MAX_VOTE_REASON * 2).optional();
/** Ask for the ballot text to sign. */
export const ballotRequestSchema = z.object({ choice: z.enum(VoteChoice), reason: voteReason });
/** The signed ballot: the same choice and reason, the issue time from the ballot text, the CIP-30 signature. */
export const castVoteSchema = z.object({
  choice: z.enum(VoteChoice),
  reason: voteReason,
  signedAt: z.iso.datetime(),
  key: z.string().max(1000).regex(/^[0-9a-f]+$/i, "must be hex"),
  signature: z.string().max(4000).regex(/^[0-9a-f]+$/i, "must be hex"),
});
export const endProposalSchema = z.object({ reason: z.string().trim().max(500).optional() });

// --- GitHub -------------------------------------------------------------------

export const workgroupIdQuerySchema = z.object({ workgroupId: id });
export const budgetResetSchema = z.object({
  workgroupId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  confirmation: z.string().min(1).max(500),
  reason: z.string().trim().min(1).max(500),
});
export const workgroupLifecycleSchema = z.object({
  workgroupId: z.uuid(),
  action: z.enum(["archive", "restore", "delete"]),
  confirmation: text(500).optional(),
});
/** Change a workgroup's payment wallet from this or the next budget period. */
export const workgroupRoutingSchema = z.object({
  workgroupId: z.uuid(),
  /** Null = any community wallet. */
  treasuryId: z.uuid().nullable(),
  effective: z.enum(["current", "next"]),
  reason: z.string().trim().max(500).optional(),
});
export const connectQuerySchema = z.object({ returnTo: text(200).optional() });
/** The repo's name is read from GitHub by the route, never taken from the body. */
export const linkRepoSchema = z.object({
  communityId: id,
  installationId: z.number().int().positive(),
  repoId: z.number().int().positive(),
  workgroupId: id,
  payableLabel: text(100).optional(),
  importStatus: text(100).optional(),
  /** Status paid issues move to; "" disables, undefined keeps the default. */
  paidStatus: text(100).optional(),
});
export const disconnectInstallationSchema = z.object({
  communityId: id,
  installationId: z.number().int().positive(),
});
export const syncRepoSchema = z.object({ repoId: z.number().int().positive() });
/** A GitHub login (assignee picker / issue assignee write). */
const githubLogin = z.string().trim().min(1).max(39).regex(/^[A-Za-z0-9-]+$/, "Invalid GitHub login");
/**
 * Picker data for the in-app GitHub issue editor: assignable users for the
 * issue's repo and the project's number field names (bounty fields).
 */
export const githubEditorOptionsQuerySchema = z.union([
  z.object({ taskId: id }),
  z.object({ workgroupId: id, itemNodeId: nonEmpty.max(200) }),
]);
/**
 * Create (or reuse) a GitHub Projects NUMBER field for bounties, from ADA or
 * a token held by a community treasury. Target is an imported task or a live
 * project item (same shape as editor-options).
 */
const githubProjectFieldTarget = z.union([
  z.object({ taskId: id }),
  z.object({ workgroupId: id, itemNodeId: nonEmpty.max(200) }),
]);
const githubProjectFieldName = z.string().trim().min(1).max(32);
export const githubProjectFieldSchema = z.intersection(
  githubProjectFieldTarget,
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ada"), fieldName: githubProjectFieldName }),
    z.object({
      kind: z.literal("token"),
      fieldName: githubProjectFieldName,
      unit: z.string().regex(ASSET_UNIT_RE, "Invalid token unit"),
      treasuryId: id,
    }),
  ]),
);
export type GithubProjectFieldBody = z.infer<typeof githubProjectFieldSchema>;
/**
 * Create or edit a GitHub issue from the app; pushed to GitHub by
 * /api/github/issue. A `create` opens a new issue on a linked repo and adds
 * it to a project Status column. A `task` edit names an imported task, an
 * `item` edit a live project item that was never imported. Edits need at
 * least one editable field.
 */
const githubIssueEditFields = {
  title: nonEmpty.max(256).optional(),
  body: z.string().max(65_536).nullable().optional(),
  labels: z.array(nonEmpty.max(50)).max(100).optional(),
  state: z.enum(["open", "closed"]).optional(),
  status: nonEmpty.max(100).optional(),
  /** Complete GitHub assignee login set (max 10); [] clears. */
  assignees: z.array(githubLogin).max(10).optional(),
  amounts: z
    .record(nonEmpty.max(64), z.string().trim().max(60).regex(/^\d+(?:\.\d+)?$/, "Enter a positive number").or(z.literal("")))
    .refine((a) => Object.keys(a).length <= 50, "Too many bounty fields")
    .optional(),
};
const hasGithubEdit = (b: Record<string, unknown>) =>
  b.title !== undefined || b.body !== undefined || b.labels !== undefined ||
  b.state !== undefined || b.status !== undefined || b.assignees !== undefined ||
  b.amounts !== undefined;
export const githubIssueEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskId: id, ...githubIssueEditFields })
    .refine(hasGithubEdit, { message: "Nothing to update" }),
  z.object({ kind: z.literal("item"), workgroupId: id, itemNodeId: nonEmpty.max(200), ...githubIssueEditFields })
    .refine(hasGithubEdit, { message: "Nothing to update" }),
  z.object({
    kind: z.literal("create"),
    workgroupId: id,
    projectId: nonEmpty.max(200),
    repoId: z.number().int().positive(),
    title: nonEmpty.max(256),
    status: nonEmpty.max(100),
  }),
]);
export type GithubIssueEditBody = z.infer<typeof githubIssueEditSchema>;
export const githubSetupQuerySchema = z.object({
  installation_id: z.coerce.number().int().positive(),
  state: z.string().min(1),
});

// --- IPFS ---------------------------------------------------------------------

export const ipfsSignUploadSchema = z.object({
  communityId: id,
  name: text(200).optional(),
  mimeType: z.string().max(100).regex(IMAGE_MIME_RE, "Only image uploads are allowed")
    // An SVG is a document that can carry scripts: never pinned for the community.
    .refine((type) => !/^image\/svg/i.test(type), "SVG images cannot be uploaded: use PNG, JPEG, GIF or WebP"),
  size: z
    .number()
    .int()
    .positive()
    .max(
      MAX_IMAGE_BYTES,
      `Image must be between 1 byte and ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
    ),
});

// --- Inferred body types ------------------------------------------------------

export type CreateCommunityBody = z.infer<typeof createCommunitySchema>;
export type PatchCommunityBody = z.infer<typeof patchCommunitySchema>;
export type MemberAddBody = z.infer<typeof memberAddSchema>;
export type MemberPatchBody = z.infer<typeof memberPatchSchema>;
export type MemberDeleteBody = z.infer<typeof memberDeleteSchema>;
export type CreateInviteBody = z.infer<typeof createInviteSchema>;
export type RevokeInviteBody = z.infer<typeof revokeInviteSchema>;
export type WorkgroupLeadBody = z.infer<typeof workgroupLeadAddSchema>;
export type TaskAssigneeInput = z.infer<typeof taskAssigneeInputSchema>;
export type SetTaskAssigneesBody = z.infer<typeof setTaskAssigneesSchema>;
export type CreateTreasuryBody = z.infer<typeof createTreasurySchema>;
export type SetTreasuryDiscordDestinationBody = z.infer<typeof setTreasuryDiscordDestinationSchema>;
export type DevDiscordSendBody = z.infer<typeof devDiscordSendSchema>;
export type DevCronRunBody = z.infer<typeof devCronRunSchema>;
export type DevAnchorTestBody = z.infer<typeof devAnchorTestSchema>;
export type SignTxBody = z.infer<typeof signTxSchema>;
export type BuildPayoutBody = z.infer<typeof buildPayoutSchema>;
export type BuildPaymentBody = z.infer<typeof buildPaymentSchema>;
export type BuildMintBody = z.infer<typeof buildMintSchema>;
export type MintAssetInput = z.infer<typeof mintAssetInputSchema>;
export type MintPolicyInput = z.infer<typeof mintPolicySchema>;
export type CreateCallBody = z.input<typeof createCallSchema>;
export type PatchCallBody = z.infer<typeof patchCallSchema>;
export type CreateMeetingLinkBody = z.input<typeof createMeetingLinkSchema>;
export type PatchMeetingLinkBody = z.infer<typeof patchMeetingLinkSchema>;
export type AddAttendeesBody = z.infer<typeof addAttendeesSchema>;
export type PatchAttendeeBody = z.input<typeof patchAttendeeSchema>;
export type CallCheckinBody = z.infer<typeof callCheckinSchema>;
export type ReconcileMatchBody = z.infer<typeof reconcileMatchSchema>;
export type IncomingDetailsBody = z.infer<typeof incomingDetailsSchema>;
export type FundingSourceBody = z.input<typeof fundingSourceSchema>;
export type PatchFundingSourceBody = z.input<typeof patchFundingSourceSchema>;
export type FundingCommitmentBody = z.input<typeof fundingCommitmentSchema>;
export type PatchFundingCommitmentBody = z.input<typeof patchFundingCommitmentSchema>;
export type FundingScheduleBody = z.input<typeof fundingScheduleSchema>;
export type ChainImportWorkgroupBody = z.infer<typeof chainImportWorkgroupSchema>;
export type ChainImportResolveBody = z.infer<typeof chainImportResolveSchema>;
export type CreateLegacyWalletBody = z.infer<typeof createLegacyWalletSchema>;
export type PatchLegacyWalletBody = z.infer<typeof patchLegacyWalletSchema>;
export type LegacyWorkgroupBody = z.infer<typeof legacyWorkgroupSchema>;
export type LegacyUploadBody = z.input<typeof legacyUploadSchema>;
export type UpsertBudgetsBody = z.infer<typeof upsertBudgetsSchema>;
export type SaveBudgetSetupBody = z.input<typeof saveBudgetSetupSchema>;
export type SaveGovernanceSettingsBody = z.infer<typeof saveGovernanceSettingsSchema>;
export type SaveGovernanceCommunitySettingsBody = z.infer<typeof saveGovernanceCommunitySettingsSchema>;
export type CreateProposalBody = z.input<typeof createProposalSchema>;
export type BallotRequestBody = z.input<typeof ballotRequestSchema>;
export type CastVoteBody = z.input<typeof castVoteSchema>;
export type LinkRepoBody = z.infer<typeof linkRepoSchema>;
export type IpfsSignUploadBody = z.infer<typeof ipfsSignUploadSchema>;

// --- Agent API OAuth (consent page, Settings connections) ----------------------

/** The signed authorization-request handle the consent page carries. */
const oauthHandle = z.string().min(1).max(8000);
export const oauthRequestQuerySchema = z.object({ request: oauthHandle });
export const oauthDecisionSchema = z.object({
  request: oauthHandle,
  approved: z.boolean(),
  /** What the user ticked; it can only narrow the request. Omitted = everything requested. */
  scopes: z.array(z.string().max(100)).max(20).optional(),
});
export const oauthConnectionQuerySchema = z.object({ clientId: z.string().min(1).max(2048) });
