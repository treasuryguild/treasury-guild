import { describe, expect, it } from "vitest";
import {
  BadRequestError,
  ConflictError,
  DomainError,
  errorMessage,
  ForbiddenError,
  HttpError,
  NotFoundError,
  UnauthorizedError,
} from "./errors";
import { AssetResolutionError } from "./assets";

describe("errors", () => {
  it("carries HTTP statuses and names", () => {
    expect(new BadRequestError("x").status).toBe(400);
    expect(new UnauthorizedError().status).toBe(401);
    expect(new UnauthorizedError().message).toBe("Not authenticated");
    expect(new ForbiddenError("x").status).toBe(403);
    expect(new NotFoundError("x").status).toBe(404);
    expect(new ConflictError("x").status).toBe(409);
    expect(new NotFoundError("x").name).toBe("NotFoundError");
    expect(new NotFoundError("x")).toBeInstanceOf(HttpError);
  });

  it("conflicts always flag the body", () => {
    expect(new ConflictError("x").extra).toEqual({ conflict: true });
    expect(new ConflictError("x", { dead: true }).extra).toEqual({
      conflict: true,
      dead: true,
    });
  });

  it("asset resolution failures are domain errors", () => {
    const err = new AssetResolutionError(["HOSKY"]);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.name).toBe("AssetResolutionError");
    expect(err.unmappedFields).toEqual(["HOSKY"]);
  });

  it("extracts messages with a fallback", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("str", "fallback")).toBe("fallback");
  });
});
