import { describe, expect, it } from "vitest";
import { generateInviteToken, hashInviteToken, isInviteTokenShape, INVITE_TOKEN_LENGTH } from "./token";

describe("invite tokens", () => {
  it("are opaque base64url of fixed length", () => {
    const token = generateInviteToken();
    expect(token).toHaveLength(INVITE_TOKEN_LENGTH);
    expect(isInviteTokenShape(token)).toBe(true);
    expect(isInviteTokenShape(token.slice(0, -1))).toBe(false);
    expect(isInviteTokenShape(`${token}x`)).toBe(false);
  });

  it("hash to sha256 hex and never equal the raw value", () => {
    const token = generateInviteToken();
    const hashed = hashInviteToken(token);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toBe(token);
    expect(hashInviteToken(token)).toBe(hashed);
    expect(hashInviteToken(`${token}x`)).not.toBe(hashed);
  });
});
