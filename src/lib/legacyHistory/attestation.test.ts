import { describe, expect, it } from "vitest";
import { legacyAttestationText } from "./attestation";

describe("legacyAttestationText", () => {
  it("formats the signed import attestation exactly", () => {
    const text = legacyAttestationText({
      host: "app.example.com",
      community: "treasury-guild",
      legacyWalletId: "lw-1",
      address: "addr_test1qqqq",
      kind: "payments",
      planHash: "deadbeef",
      signedAt: "2026-11-06T12:00:00.000Z",
    });
    expect(text).toBe([
      "Treasury Guild previous-wallet import",
      "app: app.example.com",
      "community: treasury-guild",
      "legacy-wallet: lw-1",
      "address: addr_test1qqqq",
      "kind: payments",
      "plan: deadbeef",
      "signed: 2026-11-06T12:00:00.000Z",
    ].join("\n"));
  });
});
