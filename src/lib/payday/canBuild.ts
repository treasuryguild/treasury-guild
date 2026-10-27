// Mirrors the build-payout route's rule: base signers of the paying treasury
// build for any workgroup; a lead only when every selected task is in a
// workgroup they lead. Community admin alone is not enough. The server
// enforces this regardless.

export function canBuildPayout(input: {
  treasuryId: string;
  signerTreasuryIds: Set<string>;
  ledWorkgroupIds: Set<string>;
  selectedWorkgroupIds: Set<string>;
}): boolean {
  if (input.treasuryId && input.signerTreasuryIds.has(input.treasuryId)) return true;
  return (
    input.selectedWorkgroupIds.size > 0 &&
    [...input.selectedWorkgroupIds].every((id) => input.ledWorkgroupIds.has(id))
  );
}
