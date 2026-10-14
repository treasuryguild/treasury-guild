import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AssetResolutionError } from "@/lib/assets";
import {
  BadRequestError,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  UpstreamError,
} from "@/lib/errors";
import {
  cronRoute,
  errorResponse,
  isCrossSite,
  parseJson,
  parseQuery,
  publicRoute,
} from "./route";

// publicRoute reads the session cookie through next/headers, which needs a
// request scope; stub it so the wrapper can run in a plain unit test.
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => null,
  requireSession: async () => {
    throw new Error("unused");
  },
}));

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("errorResponse", () => {
  it("maps HttpError subclasses to their status", async () => {
    const cases: [Error, number][] = [
      [new BadRequestError("bad"), 400],
      [new UnauthorizedError(), 401],
      [new ForbiddenError("no"), 403],
      [new NotFoundError("gone"), 404],
      [new ConflictError("clash"), 409],
    ];
    for (const [err, status] of cases) {
      const res = errorResponse(err);
      expect(res.status).toBe(status);
      expect((await body(res)).error).toBe(err.message);
    }
  });

  it("flags conflicts and passes extra fields through", async () => {
    const conflict = await body(errorResponse(new ConflictError("c")));
    expect(conflict).toEqual({ error: "c", conflict: true });
    const bad = await body(
      errorResponse(new BadRequestError("b", { problems: ["p1"] })),
    );
    expect(bad).toEqual({ error: "b", problems: ["p1"] });
  });

  it("maps domain/upstream/unknown errors", async () => {
    expect(errorResponse(new DomainError("d")).status).toBe(400);
    expect(errorResponse(new AssetResolutionError(["X"])).status).toBe(400);
    expect(errorResponse(new UpstreamError("u")).status).toBe(502);
    expect(errorResponse(new Error("e")).status).toBe(500);
  });

  it("keeps unexpected error text out of production responses", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect((await body(errorResponse(new Error("load member role: invalid input syntax")))).error)
        .toBe("Internal error");
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await body(errorResponse(new Error("detail")))).error).toBe("detail");
    expect((await body(errorResponse("string"))).error).toBe("Internal error");
  });
});

describe("parseJson", () => {
  const schema = z.object({
    communityId: z.string().min(1),
    count: z.number().int().optional(),
    address: z.string().refine((s) => s.startsWith("addr"), "Invalid address"),
  });

  function post(payload: unknown): Request {
    return new Request("http://test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  }

  it("returns typed data", async () => {
    const data = await parseJson(post({ communityId: "c1", address: "addr1" }), schema);
    expect(data).toEqual({ communityId: "c1", address: "addr1" });
  });

  it("reports missing fields by name", async () => {
    await expect(parseJson(post({ address: "addr1" }), schema)).rejects.toThrow(
      "communityId is required",
    );
  });

  it("keeps refine messages verbatim and prefixes type errors with the path", async () => {
    await expect(
      parseJson(post({ communityId: "c1", address: "nope" }), schema),
    ).rejects.toThrow("Invalid address");
    await expect(
      parseJson(post({ communityId: "c1", address: "addr1", count: "3" }), schema),
    ).rejects.toThrow(/^count: /);
  });

  it("treats malformed JSON as an empty body", async () => {
    await expect(parseJson(post("{not json"), schema)).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});

describe("parseQuery", () => {
  it("reads the first value of each key", () => {
    const req = new Request("http://test/api?address=a1&address=a2&n=5");
    const schema = z.object({ address: z.string(), n: z.coerce.number() });
    expect(parseQuery(req, schema)).toEqual({ address: "a1", n: 5 });
  });

  it("400s on missing params", () => {
    const req = new Request("http://test/api");
    expect(() => parseQuery(req, z.object({ address: z.string() }))).toThrow(
      "address is required",
    );
  });
});

describe("cross-site guard", () => {
  const request = (method: string, headers: Record<string, string> = {}) =>
    new Request("http://app.example/api/thing", { method, headers });

  it("flags mutating requests that declare a foreign origin", () => {
    expect(isCrossSite(request("POST", { "sec-fetch-site": "cross-site" }))).toBe(true);
    // A sibling subdomain is same-site to the browser but not this app.
    expect(isCrossSite(request("POST", { "sec-fetch-site": "same-site" }))).toBe(true);
    expect(
      isCrossSite(request("DELETE", { origin: "https://evil.example", host: "app.example" })),
    ).toBe(true);
    expect(isCrossSite(request("POST", { origin: "null" }))).toBe(true);
    expect(isCrossSite(request("POST", { origin: "not a url" }))).toBe(true);
  });

  it("passes same-origin and header-less requests", () => {
    expect(isCrossSite(request("POST", { "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossSite(request("POST", { "sec-fetch-site": "none" }))).toBe(false);
    expect(
      isCrossSite(request("PATCH", { origin: "http://app.example", host: "app.example" })),
    ).toBe(false);
    // No host header: falls back to the request URL's host.
    expect(isCrossSite(request("POST", { origin: "http://app.example" }))).toBe(false);
    // Webhooks, cron and curl send neither header.
    expect(isCrossSite(request("POST"))).toBe(false);
  });

  it("never blocks navigations or reads", () => {
    expect(isCrossSite(request("GET", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isCrossSite(request("HEAD", { origin: "https://evil.example" }))).toBe(false);
  });

  it("returns 403 from the route wrapper before the handler runs", async () => {
    let ran = false;
    const handler = publicRoute(async () => {
      ran = true;
      return { ok: true };
    });
    const call = (headers: Record<string, string>) =>
      handler(request("POST", headers), { params: Promise.resolve({}) });

    const blocked = await call({ "sec-fetch-site": "cross-site" });
    expect(blocked.status).toBe(403);
    expect((await body(blocked)).error).toBe("Cross-site request rejected");
    expect(ran).toBe(false);

    const allowed = await call({ origin: "http://app.example", host: "app.example" });
    expect(allowed.status).toBe(200);
    expect(ran).toBe(true);
  });
});

describe("cronRoute", () => {
  const previous = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = "s3cret";
  });
  afterEach(() => {
    process.env.CRON_SECRET = previous;
  });

  const handler = cronRoute(async () => ({ ran: true }));
  const call = (auth?: string) =>
    handler(
      new Request("http://test/api/cron", {
        method: "POST",
        headers: auth ? { authorization: auth } : {},
      }),
      { params: Promise.resolve({}) },
    );

  it("rejects missing or wrong bearer tokens", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    expect((await call("Bearer s3cret-but-longer")).status).toBe(401);
  });

  it("runs the handler with the right token", async () => {
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ran: true });
  });
});
