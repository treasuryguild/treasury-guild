// The text a voter signs (CIP-30 signData). The server builds it, hands it to
// the browser to sign, and builds it again from its own data when the signed
// ballot comes back, so a signature only ever vouches for this exact text:
// this app, this proposal's content and rules, this choice, this voter.
// Hashes stand in for the proposal's text to keep the payload small enough
// for hardware wallets. Client-safe.

export interface BallotFields {
  /** The app's host (APP_URL), as in the login challenge. */
  host: string;
  community: string;
  proposalNumber: number;
  proposalId: string;
  contentHash: string;
  rulesHash: string;
  /**
   * sha256 of the voter list (migration 0060), signed so the list cannot
   * change once a ballot exists. Absent or null for a proposal whose voting
   * opened before the hash existed: its ballots keep the shorter text.
   */
  electorateHash?: string | null;
  choice: string;
  /** Already normalized (normalizeReason); null when none. */
  reason: string | null;
  voter: string;
  /** ISO time the ballot was issued. */
  signedAt: string;
}

export function ballotText(f: BallotFields): string {
  return [
    "Treasury Guild ballot",
    `app: ${f.host}`,
    `community: ${f.community}`,
    `proposal: #${f.proposalNumber} ${f.proposalId}`,
    `content: ${f.contentHash}`,
    `rules: ${f.rulesHash}`,
    ...(f.electorateHash ? [`electorate: ${f.electorateHash}`] : []),
    `choice: ${f.choice}`,
    `reason: ${f.reason ?? "-"}`,
    `voter: ${f.voter}`,
    `signed: ${f.signedAt}`,
  ].join("\n");
}

/** One line of text, or null: a reason cannot add lines to the ballot. */
export function normalizeReason(reason: string | null | undefined): string | null {
  const flat = (reason ?? "").replace(/\s+/g, " ").trim();
  return flat === "" ? null : flat;
}

/** A ballot text is signed within this long of being issued. */
export const BALLOT_MAX_AGE_MS = 10 * 60 * 1000;
/** Clock skew tolerated for a ballot issued "in the future". */
const BALLOT_MAX_SKEW_MS = 60 * 1000;

export function isFreshBallot(signedAt: string, now: number): boolean {
  const at = Date.parse(signedAt);
  return Number.isFinite(at) && at <= now + BALLOT_MAX_SKEW_MS && now - at <= BALLOT_MAX_AGE_MS;
}
