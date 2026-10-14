// The check-in code a host shares during a call. Attendees confirm presence
// with their signed-in wallet, so identity is exact on every platform; the
// code and its time window are the (soft) proof of presence.

import { CHECKIN_EARLY_MS } from "@/lib/constants";

/** No 0/O, 1/I/L: the code is read aloud and typed from a shared screen. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CHECKIN_CODE_LENGTH = 6;

export function generateCheckinCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CHECKIN_CODE_LENGTH * 2));
  let code = "";
  // Rejection sampling keeps every character equally likely.
  for (const byte of bytes) {
    if (code.length === CHECKIN_CODE_LENGTH) break;
    if (byte < ALPHABET.length * 8) code += ALPHABET[byte % ALPHABET.length];
  }
  return code.length === CHECKIN_CODE_LENGTH ? code : generateCheckinCode();
}

/** As typed -> as stored: case, spaces and dashes do not matter. */
export function normalizeCheckinCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

/** Length-independent comparison of a typed code with the stored one. */
export function checkinCodeMatches(input: string, stored: string): boolean {
  const typed = normalizeCheckinCode(input);
  let diff = typed.length ^ stored.length;
  for (let i = 0; i < stored.length; i++) {
    diff |= (typed.charCodeAt(i) || 0) ^ stored.charCodeAt(i);
  }
  return diff === 0;
}

export type CheckinWindow = "early" | "open" | "closed";

/** Check-in runs from shortly before the start until the call ends. */
export function checkinWindow(
  call: { starts_at: string; ends_at: string },
  now: number,
): CheckinWindow {
  if (now < Date.parse(call.starts_at) - CHECKIN_EARLY_MS) return "early";
  return now <= Date.parse(call.ends_at) ? "open" : "closed";
}
