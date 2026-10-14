import { describe, expect, it } from "vitest";
import { ApiError, apiUrl, describeApiError } from "./client";

describe("describeApiError", () => {
  it("uses the API error message and appends problems", () => {
    expect(describeApiError(new ApiError(400, { error: "Bad" }), "x")).toBe("Bad");
    expect(
      describeApiError(
        new ApiError(400, { error: "Some tasks are not payable", problems: ["a", "b"] }),
        "x",
      ),
    ).toBe("Some tasks are not payable: a; b");
  });

  it("falls back for non-API errors", () => {
    expect(describeApiError(new Error("boom"), "fallback")).toBe("boom");
    expect(describeApiError("nope", "fallback")).toBe("fallback");
  });

  it("exposes the conflict flag", () => {
    expect(new ApiError(409, { error: "c", conflict: true }).conflict).toBe(true);
    expect(new ApiError(409, { error: "c" }).conflict).toBe(false);
  });
});

describe("apiUrl", () => {
  it("returns the path untouched without a query", () => {
    expect(apiUrl("/api/tasks")).toBe("/api/tasks");
    expect(apiUrl("/api/tasks", {})).toBe("/api/tasks");
  });

  it("appends key=value pairs in order", () => {
    expect(apiUrl("/api/tasks", { community: "signius", limit: 5 })).toBe("/api/tasks?community=signius&limit=5");
  });

  it("skips null and undefined, keeping the other falsy values", () => {
    expect(apiUrl("/api/tasks", { a: null, b: undefined, c: 0, d: false, e: "" })).toBe("/api/tasks?c=0&d=false&e=");
  });

  it("adds no question mark when every value is skipped", () => {
    expect(apiUrl("/api/tasks", { a: null, b: undefined })).toBe("/api/tasks");
  });

  it("stringifies numbers and booleans", () => {
    expect(apiUrl("/api/x", { n: 1.5, yes: true })).toBe("/api/x?n=1.5&yes=true");
  });

  it("encodes keys and values", () => {
    const url = apiUrl("/api/discord/connect", { returnTo: "/c/signius/settings?tab=a&b=c#top", "odd key": "a b+c/é" });
    expect(url).toBe(
      "/api/discord/connect?returnTo=%2Fc%2Fsignius%2Fsettings%3Ftab%3Da%26b%3Dc%23top&odd+key=a+b%2Bc%2F%C3%A9",
    );
    const parsed = new URL(url, "http://localhost").searchParams;
    expect(parsed.get("returnTo")).toBe("/c/signius/settings?tab=a&b=c#top");
    expect(parsed.get("odd key")).toBe("a b+c/é");
  });

  it("continues a path that already has a query with &", () => {
    expect(apiUrl("/api/x?a=1", { b: 2 })).toBe("/api/x?a=1&b=2");
    expect(apiUrl("/api/x?a=1", { b: null })).toBe("/api/x?a=1");
  });
});
