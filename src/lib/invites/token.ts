// Opaque invite tokens: random base64url, stored only as sha256.
import { randomBytes } from "node:crypto";
import { sha256Hex } from "@/lib/auth/crypto";

/** 32 random bytes → 43-char base64url (no padding). */
export const INVITE_TOKEN_LENGTH = 43;

const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return sha256Hex(token);
}

export function isInviteTokenShape(token: string): boolean {
  return INVITE_TOKEN_RE.test(token);
}
