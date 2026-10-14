import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
import { POST } from "./route";

const context = { params: Promise.resolve({}) };
const request = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/auth/logout", { method: "POST", headers });
/** The session cookie a response sets: its value and its lower-cased attributes. */
function sessionCookie(response: Response): { value: string; attributes: string[] } | null {
  const header = response.headers.getSetCookie().find((c) => c.startsWith("tg_session="));
  if (!header) return null;
  const [pair, ...attributes] = header.split("; ");
  return { value: pair!.slice("tg_session=".length), attributes: attributes.map((a) => a.toLowerCase()) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "addr_test1wallet" });
});

describe("auth logout API", () => {
  it("clears the session cookie on the path it was set for", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const cookie = sessionCookie(response)!;
    expect(cookie.value).toBe("");
    expect(cookie.attributes).toContain("path=/");
    expect(cookie.attributes).toContain("max-age=0");
  });

  it("clears it just the same when nobody is signed in", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(sessionCookie(response)).toMatchObject({ value: "" });
  });

  it("refuses a request that declares another origin, leaving the session alone", async () => {
    const response = await POST(request({ "Sec-Fetch-Site": "cross-site" }), context);
    expect(response.status).toBe(403);
    expect(sessionCookie(response)).toBeNull();
  });
});
