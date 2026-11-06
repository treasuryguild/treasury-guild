export type LegacyAttestKind = "payments" | "receipts";

export interface LegacyAttestationFields {
  host: string;
  community: string;
  legacyWalletId: string;
  address: string;
  kind: LegacyAttestKind;
  planHash: string;
  signedAt: string;
}

export function legacyAttestationText(f: LegacyAttestationFields): string {
  return [
    "Treasury Guild previous-wallet import",
    `app: ${f.host}`,
    `community: ${f.community}`,
    `legacy-wallet: ${f.legacyWalletId}`,
    `address: ${f.address}`,
    `kind: ${f.kind}`,
    `plan: ${f.planHash}`,
    `signed: ${f.signedAt}`,
  ].join("\n");
}
