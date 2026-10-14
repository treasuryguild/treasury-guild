// The reference a call or linked meeting stores for its platform: a Zoom
// meeting id (9 to 11 digits) or a Meet code (abc-mnop-xyz). One home for the
// rule, shared by the forms that normalise what a manager typed and the API
// schemas that check what arrives. Client-safe.

import { MEET_CODE_RE, normalizeMeetCode } from "./meetSessions";
import { normalizeMeetingId } from "./zoomSessions";

export type MeetingPlatform = "zoom" | "meet";

const ZOOM_MEETING_ID_RE = /^\d{9,11}$/;

export const ZOOM_MEETING_ID_ERROR = "A Zoom meeting ID has 9 to 11 digits";
export const MEET_CODE_ERROR = "A Meet code looks like abc-mnop-xyz";

/** A stored reference is well-formed for its platform. */
export function isMeetingRef(platform: MeetingPlatform, ref: string): boolean {
  return platform === "zoom" ? ZOOM_MEETING_ID_RE.test(ref) : MEET_CODE_RE.test(ref);
}

/** What someone typed (spaces, dashes, a Meet link) -> the stored reference, or null. */
export function parseMeetingRef(platform: MeetingPlatform, input: string): string | null {
  if (platform === "meet") return normalizeMeetCode(input);
  const id = normalizeMeetingId(input);
  return isMeetingRef("zoom", id) ? id : null;
}
