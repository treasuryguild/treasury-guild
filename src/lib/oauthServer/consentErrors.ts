// Why /api/oauth/authorize refused a request before a handle existed. The
// consent page is sent a code (?error=<code>), never text: anything in the URL
// is attacker-chosen, and free text rendered on this origin would let anyone
// put their own words on a Treasury Guild page. Client-safe.

export const CONSENT_ERROR_MESSAGES = {
  invalid_request: "the request is missing the assistant's identity or return address",
  invalid_client: "Treasury Guild does not know this assistant",
  unregistered_redirect: "the assistant asked to return somewhere it did not register",
  bad_redirect_scheme: "the assistant's return address is not allowed",
} as const;

export type ConsentErrorCode = keyof typeof CONSENT_ERROR_MESSAGES;

const FALLBACK = "the request is not valid";

/** The fixed message of a code; a generic one for anything else. */
export function consentErrorMessage(code: string | null): string {
  return code && Object.hasOwn(CONSENT_ERROR_MESSAGES, code)
    ? CONSENT_ERROR_MESSAGES[code as ConsentErrorCode]
    : FALLBACK;
}
