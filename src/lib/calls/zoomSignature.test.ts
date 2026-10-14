import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyZoomSignature, zoomUrlValidationResponse } from "./zoomSignature";

const secret = "zoom-secret-token";
const rawBody = JSON.stringify({ event: "meeting.participant_joined", payload: { account_id: "a1" } });
const now = Date.parse("2026-09-01T17:00:00Z");
const timestamp = String(now / 1000);
const sign = (ts: string, body: string, key = secret) =>
  `v0=${createHmac("sha256", key).update(`v0:${ts}:${body}`).digest("hex")}`;

describe("verifyZoomSignature", () => {
  it("accepts Zoom's signature over timestamp and raw body", () => {
    expect(verifyZoomSignature({ secret, timestamp, signature: sign(timestamp, rawBody), rawBody, now })).toBe(true);
  });

  it("refuses a changed body, another secret, or missing headers", () => {
    const signature = sign(timestamp, rawBody);
    expect(verifyZoomSignature({ secret, timestamp, signature, rawBody: rawBody + " ", now })).toBe(false);
    expect(verifyZoomSignature({ secret, timestamp, signature: sign(timestamp, rawBody, "other"), rawBody, now })).toBe(false);
    expect(verifyZoomSignature({ secret, timestamp: null, signature, rawBody, now })).toBe(false);
    expect(verifyZoomSignature({ secret, timestamp, signature: null, rawBody, now })).toBe(false);
    expect(verifyZoomSignature({ secret, timestamp, signature: "v0=short", rawBody, now })).toBe(false);
  });

  it("refuses a replay of an old, validly signed request", () => {
    const old = String(now / 1000 - 6 * 60);
    expect(verifyZoomSignature({ secret, timestamp: old, signature: sign(old, rawBody), rawBody, now })).toBe(false);
    expect(verifyZoomSignature({ secret, timestamp: "soon", signature: sign("soon", rawBody), rawBody, now })).toBe(false);
  });
});

describe("zoomUrlValidationResponse", () => {
  it("signs the plain token with the secret", () => {
    expect(zoomUrlValidationResponse(secret, "abc123")).toEqual({
      plainToken: "abc123",
      encryptedToken: createHmac("sha256", secret).update("abc123").digest("hex"),
    });
  });
});
