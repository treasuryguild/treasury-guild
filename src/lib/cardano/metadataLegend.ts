// Human legends for the on-chain metadata the app shows raw: what each key
// of a label-190001 payout record (metadata.ts), a label-190001 payment
// record (paymentMetadata.ts), a label-721 CIP-25 record (mintMetadata.ts),
// a label-190002 anchor record and a label-1854 CIP-0146 registration
// means. Pure data, client-safe; the JSON viewer renders it next to the
// record so a signer can read the chain without the docs open. The wording
// mirrors the "On-chain metadata" sections of the user docs, which stay the
// long-form reference.

import { docHref } from "@/lib/docs";
import { isRecord } from "@/lib/guards";
import { ANCHOR_METADATA_VERSION, parseAnchorMetadata } from "./anchorMetadata";
import { parseLabel1854Metadata } from "./cip146Registration";
import { PAYOUT_METADATA_VERSION } from "./metadata";
import { PAYMENT_METADATA_TYPE, PAYMENT_METADATA_VERSION } from "./paymentMetadata";

export interface MetadataLegendEntry {
  key: string;
  meaning: string;
}

export interface MetadataLegend {
  /** Which record this legend explains, for the heading. */
  title: string;
  entries: readonly MetadataLegendEntry[];
  /** Long-form reference in the user docs. */
  docs: { href: string; label: string };
}

const COMMON_HEAD: readonly MetadataLegendEntry[] = [
  { key: "src", meaning: 'Always "treasury-guild": marks a record written by Treasury Guild.' },
  { key: "c", meaning: "The community's slug (its address in the app)." },
];

export const PAYOUT_METADATA_LEGEND: MetadataLegend = {
  title: "Task payout record",
  entries: [
    { key: "v", meaning: `Record version (${PAYOUT_METADATA_VERSION}).` },
    ...COMMON_HEAD,
    { key: "w", meaning: "Workgroup names used in this payout; tasks refer to them by position." },
    {
      key: "b",
      meaning:
        'Budget periods used in this payout: "YYYY-MM" for a workgroup budgeted by month, "YYYY-Qn" for one budgeted by quarter; tasks refer to them by position.',
    },
    { key: "k", meaning: 'Asset tickers, "ADA" included; every amounts list follows this order.' },
    {
      key: "p",
      meaning:
        'One entry per paid output: [output position, tasks]. Each task is [task number, position in w, position in b, amounts in k order] with "" where the task pays none of that asset. Amounts are the bounties in display units; the ADA minimum on token-only outputs is not repeated.',
    },
    {
      key: "g",
      meaning:
        "The decisions behind the payout: one entry per cited proposal, [proposal number, content hash, task numbers]. A task cites the proposal that created it and the budget proposal that set its period's budget. Absent when nothing is cited.",
    },
  ],
  docs: { href: docHref({ slug: "transactions", hash: "on-chain-metadata" }), label: "On-chain metadata" },
};

export const PAYMENT_METADATA_LEGEND: MetadataLegend = {
  title: "Payment record",
  entries: [
    { key: "v", meaning: `Record version (${PAYMENT_METADATA_VERSION}).` },
    ...COMMON_HEAD,
    { key: "t", meaning: `"${PAYMENT_METADATA_TYPE}": a manual payment, not a task payout (payouts have no t and carry p instead).` },
    {
      key: "b",
      meaning:
        'Budget period the spending counts against, "YYYY-MM" or "YYYY-Qn". Empty when every output is a transfer to another of the community\'s treasuries, which counts against no budget.',
    },
    { key: "k", meaning: 'Asset tickers, "ADA" included; every amounts list follows this order.' },
    { key: "m", meaning: "The memo entered when the payment was built; absent when none was." },
    {
      key: "o",
      meaning:
        'One entry per paid output: [output position, amounts in k order, flag] with "" where the output carries none of that asset. Flag 0 = spending charged to the treasury\'s budget, 1 = transfer to another of the community\'s treasuries. The ADA minimum on token-only outputs is not repeated.',
    },
    {
      key: "g",
      meaning:
        "The decisions behind the payment: [proposal number, content hash] per cited proposal, such as the budget proposal that set the period's budget. Absent when nothing is cited.",
    },
  ],
  docs: { href: docHref({ slug: "payments", hash: "on-chain-record" }), label: "On-chain record" },
};

export const CIP25_METADATA_LEGEND: MetadataLegend = {
  title: "CIP-25 token record",
  entries: [
    { key: "<policy id>", meaning: "Top level: the minting policy, which is the treasury's multisig script (plus its time lock, if any)." },
    { key: "<asset name>", meaning: "Under the policy: the on-chain name of each token minted, with its properties." },
    { key: "name", meaning: "Display name shown by wallets and explorers." },
    { key: "image", meaning: 'The token image or logo as an "ipfs://" link, pinned on IPFS.' },
    { key: "mediaType", meaning: "MIME type of the image." },
    { key: "description", meaning: "Free-text description, when one was entered." },
    { key: "files", meaning: "Further files attached to the token, each with a name, mediaType and src." },
    { key: "ticker", meaning: "Fungible tokens: the short symbol, which Payday matches bounties against." },
    { key: "decimals", meaning: "Fungible tokens: how many decimal places the display unit has." },
    { key: "url", meaning: "Fungible tokens: the project website, when one was entered." },
    { key: "…", meaning: "Any other key is an NFT trait entered on the mint form." },
  ],
  docs: { href: docHref({ slug: "mint", hash: "signing-and-confirmation" }), label: "Signing and confirmation" },
};

export const ANCHOR_METADATA_LEGEND: MetadataLegend = {
  title: "Proposal anchor record",
  entries: [
    { key: "v", meaning: `Record version (${ANCHOR_METADATA_VERSION}).` },
    ...COMMON_HEAD,
    {
      key: "a",
      meaning:
        'One entry per proposal step, [proposal number, step, …]: "proposed" then the content hash and rules hash every ballot signs (sha256 of canonical JSON); "opened" then the hash of the fixed voter list; "closed" then the final state and, for a proposal that reached voting, the blake2b-256 hash of its frozen signed tally, [voters, ballots, [[choice, count], …]] and, when published, [store, locator] of the copy (for IPFS, the CID).',
    },
  ],
  docs: { href: docHref({ slug: "governance", hash: "on-chain-anchors" }), label: "On-chain anchors" },
};

export const REGISTRATION_METADATA_LEGEND: MetadataLegend = {
  title: "CIP-0146 wallet registration",
  entries: [
    {
      key: "types",
      meaning:
        "Roles this registration covers: 0 = payment (always), 2 = stake, 3 = DRep. Stake and DRep appear when the treasury is an SDK wallet with those keys.",
    },
    {
      key: "name",
      meaning:
        "The treasury's display name. Strings longer than 64 UTF-8 bytes are split into an array of chunks (joined when shown).",
    },
    {
      key: "description",
      meaning: "Optional free-text description, chunked like name. Absent when none was set.",
    },
    {
      key: "participants",
      meaning:
        "Map of key hash → { name }: every payment, stake and DRep key of the treasury's signers, each with that signer's display name truncated to 64 UTF-8 bytes. Co-signers use this to discover and import the wallet.",
    },
  ],
  docs: { href: docHref({ slug: "transactions", hash: "on-chain-registration" }), label: "On-chain registration" },
};

/** The legend for a decoded label-190002 value: the anchor record, or null for the test record and anything else. */
export function anchorLegend(meta: unknown): MetadataLegend | null {
  return parseAnchorMetadata(meta) ? ANCHOR_METADATA_LEGEND : null;
}

/** The legend for a decoded label-1854 registration, or null when the value is not one. */
export function registrationLegend(meta: unknown): MetadataLegend | null {
  return parseLabel1854Metadata(meta) ? REGISTRATION_METADATA_LEGEND : null;
}

/** The legend for a decoded label-190001 record, chosen by its shape; null for anything else. */
export function payoutOrPaymentLegend(meta: unknown): MetadataLegend | null {
  if (!isRecord(meta)) return null;
  const m = meta;
  if (m.t === PAYMENT_METADATA_TYPE || Array.isArray(m.o)) return PAYMENT_METADATA_LEGEND;
  if (Array.isArray(m.p)) return PAYOUT_METADATA_LEGEND;
  return null;
}
