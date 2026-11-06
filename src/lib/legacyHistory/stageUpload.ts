// Stage a browser-uploaded previous-wallet CSV (payments or receipts) and
// optionally apply one ownership signature in the same request.
import "server-only";

import { communitySlug } from "@/lib/db/communities";
import { stageLegacyHistory, stageLegacyReceipts } from "@/lib/db/legacyHistory";
import type { LegacyWalletRow } from "@/lib/db/types";
import { BadRequestError } from "@/lib/errors";
import { attestLegacyImport, type AttestImportArgs } from "./attest";
import type { LegacyImportPlan } from "./types";
import type { LegacyReceiptImportPlan } from "./receiptTypes";
import { legacyPlanHash, legacyRpcRows } from "./plan";
import { legacyReceiptRpcRows } from "./receiptPlan";
import { resolveLegacyScriptClaim } from "./scriptClaim";
import { sha256Hex } from "./run";

export function signaturesRequiredForWallet(wallet: LegacyWalletRow): number {
  if (wallet.script_cbor) return resolveLegacyScriptClaim(wallet.address, wallet.script_cbor).required;
  return 1;
}

type SignatureBody = Pick<AttestImportArgs, "key" | "signature" | "signedAt" | "signerAddress">;

export async function stagePaymentUpload(args: {
  wallet: LegacyWalletRow;
  fileName: string;
  actor: string;
  plan: LegacyImportPlan;
  includeDuplicates: boolean;
  replaceImportId: string | null;
  signature?: SignatureBody;
}) {
  if (!args.wallet.address) throw new BadRequestError("Previous wallet needs an address");
  const rows = legacyRpcRows(args.plan, args.includeDuplicates);
  const planHash = legacyPlanHash(rows, sha256Hex);
  const staged = await stageLegacyHistory({
    walletId: args.wallet.id,
    fileName: args.fileName,
    actor: args.actor,
    planHash,
    rows,
    replaceImportId: args.replaceImportId,
  });
  return finishStage({
    kind: "payments",
    wallet: args.wallet,
    staged,
    actor: args.actor,
    signature: args.signature,
    skipped: args.plan.counts.duplicates + args.plan.counts.invalid,
    replaced: args.replaceImportId !== null,
  });
}

export async function stageReceiptUpload(args: {
  wallet: LegacyWalletRow;
  fileName: string;
  actor: string;
  plan: LegacyReceiptImportPlan;
  includeDuplicates: boolean;
  replaceImportId: string | null;
  signature?: SignatureBody;
}) {
  if (!args.wallet.address) throw new BadRequestError("Previous wallet needs an address");
  const rows = legacyReceiptRpcRows(args.plan, args.includeDuplicates);
  const planHash = legacyPlanHash(rows, sha256Hex);
  const staged = await stageLegacyReceipts({
    walletId: args.wallet.id,
    fileName: args.fileName,
    actor: args.actor,
    planHash,
    rows,
    replaceImportId: args.replaceImportId,
  });
  return finishStage({
    kind: "receipts",
    wallet: args.wallet,
    staged,
    actor: args.actor,
    signature: args.signature,
    skipped: args.plan.counts.duplicates + args.plan.counts.invalid,
    replaced: args.replaceImportId !== null,
  });
}

async function finishStage(args: {
  kind: "payments" | "receipts";
  wallet: LegacyWalletRow;
  staged: { importId: string; state: "pending_signatures"; planHash: string; lineCount: number };
  actor: string;
  signature?: SignatureBody;
  skipped: number;
  replaced: boolean;
}) {
  const required = signaturesRequiredForWallet(args.wallet);
  let state: "pending_signatures" | "active" = "pending_signatures";
  let signatures = 0;
  let inserted: number | undefined;
  if (args.signature) {
    const slug = await communitySlug(args.wallet.community_id);
    const attested = await attestLegacyImport({
      kind: args.kind,
      importId: args.staged.importId,
      communitySlug: slug,
      actor: args.actor,
      ...args.signature,
    });
    state = attested.state;
    signatures = attested.signatures;
    inserted = attested.inserted;
  }
  return {
    importId: args.staged.importId,
    state,
    planHash: args.staged.planHash,
    signatures,
    required,
    inserted: inserted ?? (state === "active" ? args.staged.lineCount : undefined),
    skipped: args.skipped,
    replaced: args.replaced,
  };
}
