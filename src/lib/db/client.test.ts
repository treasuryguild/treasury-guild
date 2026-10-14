import { describe, expect, it } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";
import { PgCode } from "@/lib/constants";
import { BadRequestError, ConflictError, ForbiddenError, HttpError, NotFoundError } from "@/lib/errors";
import { allRows, optionalRelation, relation, rpc, throwRpcError } from "./client";

describe("allRows", () => {
  it("includes spending beyond the first page", async () => {
    const records = Array.from({ length: 1203 }, (_, id) => ({ id }));
    const result = await allRows<{ id: number }>(async (from, to) => ({
      data: records.slice(from, to + 1), error: null,
    }), "load spending");
    expect(result).toEqual(records);
  });

  it("rejects failed later pages instead of returning incomplete totals", async () => {
    await expect(allRows(async (from) => from === 0
      ? { data: Array(500).fill({ amount: "1" }), error: null }
      : { data: null, error: new PostgrestError({ message: "unavailable", code: "500", details: "", hint: "" }) },
    "load spending")).rejects.toThrow("load spending: unavailable");
  });
});

describe("rpc", () => {
  const failure = (code: string) => ({
    data: null,
    error: new PostgrestError({ message: `rule ${code}`, code, details: "", hint: "" }),
  });

  it("returns the data of a successful call", () => {
    expect(rpc<number>({ data: 3, error: null })).toBe(3);
  });

  it.each([
    [PgCode.NoDataFound, NotFoundError],
    [PgCode.InsufficientPrivilege, ForbiddenError],
    [PgCode.CheckViolation, ConflictError],
    [PgCode.ForeignKeyViolation, ConflictError],
    [PgCode.SerializationFailure, ConflictError],
    [PgCode.DeadlockDetected, ConflictError],
  ])("maps %s to its HTTP error with the database message", (code, ErrorClass) => {
    expect(() => rpc(failure(code))).toThrow(ErrorClass);
    expect(() => rpc(failure(code))).toThrow(`rule ${code}`);
  });

  it("lets a caller override a code and leaves unknown codes as plain errors", () => {
    expect(() => rpc(failure(PgCode.CheckViolation), { [PgCode.CheckViolation]: BadRequestError }))
      .toThrow(BadRequestError);
    const unknown = (() => { try { rpc(failure("XX000")); } catch (err) { return err; } })();
    expect(unknown).toBeInstanceOf(Error);
    expect(unknown).not.toBeInstanceOf(HttpError);
  });
});

describe("relations", () => {
  it("unwraps to-one embeds typed as arrays", () => {
    expect(relation([{ id: 1 }])).toEqual({ id: 1 });
    expect(relation({ id: 2 })).toEqual({ id: 2 });
    expect(optionalRelation([])).toBeNull();
    expect(optionalRelation(null)).toBeNull();
    expect(optionalRelation([{ id: 3 }])).toEqual({ id: 3 });
  });
});

describe("throwRpcError", () => {
  const pgError = (code: string, message = `rule ${code}`) =>
    new PostgrestError({ message, code, details: "", hint: "" });
  const thrown = (fn: () => never): unknown => {
    try { return fn(); } catch (err) { return err; }
  };

  it.each([
    [PgCode.NoDataFound, NotFoundError, 404],
    [PgCode.InsufficientPrivilege, ForbiddenError, 403],
    [PgCode.CheckViolation, ConflictError, 409],
    [PgCode.ForeignKeyViolation, ConflictError, 409],
    [PgCode.SerializationFailure, ConflictError, 409],
    [PgCode.DeadlockDetected, ConflictError, 409],
  ])("throws %s as its HttpError, carrying the database message", (code, ErrorClass, status) => {
    const err = thrown(() => throwRpcError(pgError(code, "task is already paid")));
    expect(err).toBeInstanceOf(ErrorClass);
    expect((err as HttpError).status).toBe(status);
    expect((err as HttpError).message).toBe("task is already paid");
  });

  it("always throws: an unmapped code becomes a plain Error with the message", () => {
    for (const code of ["XX000", "P0001", ""]) {
      const err = thrown(() => throwRpcError(pgError(code, "boom")));
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(HttpError);
      expect((err as Error).message).toBe("boom");
    }
  });

  it("prefers an override over the default mapping, for that code only", () => {
    const overrides = { [PgCode.CheckViolation]: BadRequestError, P0001: ConflictError };
    expect(thrown(() => throwRpcError(pgError(PgCode.CheckViolation), overrides))).toBeInstanceOf(BadRequestError);
    // A code with no default can be given one.
    expect(thrown(() => throwRpcError(pgError("P0001"), overrides))).toBeInstanceOf(ConflictError);
    // Other codes keep their default.
    expect(thrown(() => throwRpcError(pgError(PgCode.NoDataFound), overrides))).toBeInstanceOf(NotFoundError);
  });

  it("does not throw the PostgrestError itself", () => {
    const original = pgError(PgCode.NoDataFound);
    expect(thrown(() => throwRpcError(original))).not.toBe(original);
  });
});
