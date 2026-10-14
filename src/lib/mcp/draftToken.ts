// Draft tokens: what an agent API preview hands the assistant, and the only
// thing its confirming call accepts (multisig's preview -> token -> propose).
// The token carries the action and the exact request the user was shown, with
// the fingerprint the preview computed, so the confirmation does what was
// previewed or nothing.
//
// It is bound to the wallet, the OAuth client and the grant it was previewed
// under, signed with its own key (derived for this purpose only: it is never
// an access token, a session JWT or a PostgREST token, nor the reverse), and
// lives fifteen minutes. Its random id (jti) is the draft id the created row
// carries (agent_draft_id), so one draft makes one row.
import "server-only";

import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { ApiCaller } from "@/lib/api/caller";
import { hmacSha256Hex } from "@/lib/auth/crypto";
import { cronSecret, mcpTokenSecret } from "@/lib/env.server";
import { BadRequestError, ForbiddenError } from "@/lib/errors";
import { issuerOrigin } from "@/lib/oauthServer/config";

export const DRAFT_TOKEN_TYPE = "tg_mcp_draft";
const HEADER_TYPE = "tg-draft+jwt";
export const DRAFT_TOKEN_TTL_SECONDS = 15 * 60;

/** What a confirmed draft does; each has its preview tool and its write scope (src/lib/api/v1/drafts.ts). */
export const DRAFT_ACTIONS = [
  "proposal_create",
  "proposal_withdraw",
  "payout_create",
  "task_save",
  "call_create",
  "call_finalize",
] as const;
export type DraftAction = (typeof DRAFT_ACTIONS)[number];

export interface Draft {
  action: DraftAction;
  /** The community's slug, as the preview was asked for it. */
  community: string;
  /** The request the preview checked, as the action's confirmation re-reads it. */
  request: Record<string, unknown>;
  /** Stable fingerprint of what the preview showed; the confirmation must arrive at the same. */
  fingerprint: string;
  /** A proposal's frozen rules hash; "" for other actions. */
  rulesHash: string;
}

export interface VerifiedDraft extends Draft {
  /** The token's random id: the row it creates is keyed by it (agent_draft_id). */
  draftId: string;
  /** When the preview was made (epoch ms). */
  issuedAt: number;
}

function secret(): Uint8Array {
  return new TextEncoder().encode(hmacSha256Hex(mcpTokenSecret() ?? cronSecret(), "treasury-guild/mcp-draft-token"));
}

function audience(): string {
  return `${issuerOrigin()}/mcp-draft`;
}

function isDraftAction(value: unknown): value is DraftAction {
  return typeof value === "string" && (DRAFT_ACTIONS as readonly string[]).includes(value);
}

export async function mintDraftToken(
  caller: ApiCaller,
  draft: Draft,
): Promise<{ token: string; expiresAt: string }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    typ: DRAFT_TOKEN_TYPE,
    act: draft.action,
    cid: caller.clientId ?? "",
    gat: caller.grantCreatedAt ?? 0,
    com: draft.community,
    req: draft.request,
    fp: draft.fingerprint,
    rh: draft.rulesHash,
  })
    .setProtectedHeader({ alg: "HS256", typ: HEADER_TYPE })
    .setSubject(caller.wallet)
    .setIssuer(issuerOrigin())
    .setAudience(audience())
    .setIssuedAt(issuedAt)
    .setJti(randomBytes(16).toString("hex"))
    .setExpirationTime(issuedAt + DRAFT_TOKEN_TTL_SECONDS)
    .sign(secret());
  return { token, expiresAt: new Date((issuedAt + DRAFT_TOKEN_TTL_SECONDS) * 1000).toISOString() };
}

const INVALID = "This draft is not valid or has expired: preview it again";

/**
 * The draft, when this caller previewed it in the last fifteen minutes (and,
 * given `expected`, for that action); 400 / 403 otherwise.
 */
export async function verifyDraftToken(
  token: string,
  caller: ApiCaller,
  expected?: DraftAction,
): Promise<VerifiedDraft> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, secret(), {
      issuer: issuerOrigin(),
      audience: audience(),
      typ: HEADER_TYPE,
      algorithms: ["HS256"],
    }));
  } catch {
    throw new BadRequestError(INVALID);
  }
  const { typ, sub, cid, gat, com, req, fp, rh, iat, jti } = payload;
  // A token from before actions existed is a proposal draft.
  const act = payload.act ?? "proposal_create";
  if (
    typ !== DRAFT_TOKEN_TYPE || !isDraftAction(act) || typeof sub !== "string" || typeof cid !== "string"
    || typeof gat !== "number" || typeof com !== "string" || typeof req !== "object" || req === null || Array.isArray(req)
    || typeof fp !== "string" || typeof rh !== "string" || typeof iat !== "number" || typeof jti !== "string"
  ) {
    throw new BadRequestError(INVALID);
  }
  // Another wallet's, another assistant's, or one from before a Disconnect.
  if (sub !== caller.wallet || cid !== (caller.clientId ?? "") || gat !== (caller.grantCreatedAt ?? 0)) {
    throw new ForbiddenError("This draft was previewed by another connection: preview it again here");
  }
  if (expected && act !== expected) {
    throw new BadRequestError(`This draft is for ${act}, not ${expected}`);
  }
  return {
    action: act,
    community: com,
    request: req as Record<string, unknown>,
    fingerprint: fp,
    rulesHash: rh,
    issuedAt: iat * 1000,
    draftId: jti,
  };
}
