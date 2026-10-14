import { describe, expect, it } from "vitest";
import { googleSubFromIdToken } from "./identityProviders";

const CLIENT = "client-1.apps.googleusercontent.com";

function idToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

describe("googleSubFromIdToken", () => {
  it("returns the subject of a token issued by Google for this app", () => {
    expect(googleSubFromIdToken(idToken({ iss: "https://accounts.google.com", aud: CLIENT, sub: "1089" }), CLIENT))
      .toBe("1089");
    expect(googleSubFromIdToken(idToken({ iss: "accounts.google.com", aud: CLIENT, sub: "1089" }), CLIENT))
      .toBe("1089");
  });

  it("refuses another issuer, another audience, or no subject", () => {
    expect(() => googleSubFromIdToken(idToken({ iss: "https://evil.example", aud: CLIENT, sub: "1" }), CLIENT))
      .toThrow(/not issued by Google/);
    expect(() => googleSubFromIdToken(idToken({ iss: "https://accounts.google.com", aud: "other", sub: "1" }), CLIENT))
      .toThrow(/another app/);
    expect(() => googleSubFromIdToken(idToken({ iss: "https://accounts.google.com", aud: CLIENT }), CLIENT))
      .toThrow(/no subject/);
  });

  it("refuses a malformed token", () => {
    expect(() => googleSubFromIdToken("nope", CLIENT)).toThrow(/malformed/);
    expect(() => googleSubFromIdToken("a.%%%.c", CLIENT)).toThrow(/malformed/);
  });
});
