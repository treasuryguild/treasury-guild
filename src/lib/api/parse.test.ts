import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BadRequestError } from "@/lib/errors";
import { parseInput } from "./parse";

const schema = z.object({
  name: z.string().min(2),
  count: z.number().int().optional(),
  items: z.array(z.object({ id: z.string() })).optional(),
});

function failure(run: () => unknown): BadRequestError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestError);
    return err as BadRequestError;
  }
  throw new Error("expected parseInput to throw");
}

describe("parseInput", () => {
  it("returns the parsed value", () => {
    expect(parseInput(schema, { name: "Ada", count: 3 })).toEqual({ name: "Ada", count: 3 });
  });

  it("returns zod's output: defaults, coercion, unknown keys stripped", () => {
    const loose = z.object({ limit: z.coerce.number().default(5), on: z.boolean().default(false) });
    expect(parseInput(loose, { limit: "3", extra: "x" })).toEqual({ limit: 3, on: false });
    expect(parseInput(loose, {})).toEqual({ limit: 5, on: false });
  });

  it("says a missing field is required", () => {
    const err = failure(() => parseInput(schema, {}));
    expect(err.status).toBe(400);
    expect(err.message).toBe("name is required");
  });

  it("says a missing body is required", () => {
    expect(failure(() => parseInput(schema, undefined)).message).toBe("Request body is required");
  });

  it("prefixes other issues with the field path", () => {
    const wrongType = failure(() => parseInput(schema, { name: 5 })).message;
    expect(wrongType.startsWith("name: ")).toBe(true);
    expect(wrongType).toContain("string");
    const tooShort = failure(() => parseInput(schema, { name: "A" })).message;
    expect(tooShort.startsWith("name: ")).toBe(true);
  });

  it("joins a nested path with dots, array indexes included", () => {
    expect(failure(() => parseInput(schema, { name: "Ada", items: [{ id: "a" }, {}] })).message).toBe("items.1.id is required");
    expect(failure(() => parseInput(schema, { name: "Ada", items: [{ id: 1 }] })).message).toMatch(/^items\.0\.id: /);
  });

  it("gives a root-level issue without a path prefix", () => {
    const message = failure(() => parseInput(schema, "text")).message;
    expect(message).not.toMatch(/^: /);
    expect(message).toContain("object");
    expect(failure(() => parseInput(schema, null)).message).not.toBe("Request body is required");
  });

  it("keeps a refine message verbatim, without the path", () => {
    const refined = z
      .object({ from: z.number(), to: z.number() })
      .refine((v) => v.to > v.from, { message: "The end must come after the start", path: ["to"] });
    expect(failure(() => parseInput(refined, { from: 2, to: 1 })).message).toBe("The end must come after the start");
  });

  it("reports the first issue only", () => {
    const both = z.object({ a: z.string(), b: z.string() });
    expect(failure(() => parseInput(both, {})).message).toBe("a is required");
  });
});
