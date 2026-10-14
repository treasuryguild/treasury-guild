// Asset unit helpers. A unit is policyId (56 hex chars) + assetName hex;
// "lovelace" is the ADA pseudo-unit. Client-safe.

export const POLICY_ID_HEX_LENGTH = 56;

export function splitUnit(unit: string): {
  policyId: string;
  assetNameHex: string;
} {
  return {
    policyId: unit.slice(0, POLICY_ID_HEX_LENGTH),
    assetNameHex: unit.slice(POLICY_ID_HEX_LENGTH),
  };
}

export function joinUnit(policyId: string, assetNameHex: string | null | undefined): string {
  return policyId + (assetNameHex ?? "");
}

/** Byte length of the asset name part of a unit. */
export function assetNameByteLength(unit: string): number {
  return Math.ceil((unit.length - POLICY_ID_HEX_LENGTH) / 2);
}
